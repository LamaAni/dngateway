const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')
const { assert } = require('console')
const { Request, Response, NextFunction } = require('express/index')
const events = require('events')

/**
 * @param {string} target_path
 * @returns {string}
 */
function encode_hostname(target_path) {
  return target_path.replace(/[^\w.-]/g, (str) => {
    const char_num = str.charCodeAt(0)
    return `.e${char_num.toString().padStart(3, '0')}.`
  })
}

/**
 * @param {string} hostname
 * @returns {string}
 */
function decode_hostname(hostname) {
  return hostname.replace(/[.]e[0-9]{3}[.]/g, (str) => {
    const char_num = parseInt(str.substr(2, 3))
    return String.fromCharCode([parseInt(char_num)])
  })
}

function map_dns_status_to_http_code(dns_error_Code) {
  switch (dns_error_Code) {
    case dns.NOTFOUND:
      return 404
      break
    case dns.REFUSED:
    case dns.CANCELLED:
    case dns.CONNREFUSED:
      return 403
    default:
      return 500
  }
}

class GatewayRequestInfo {
  constructor() {
    /** @type {boolean} If true, the gateway should intercept this request*/
    this.is_gateway_intercept = false

    /** @type {boolean} If true, this is a gateway host (encoded in domain) request*/
    this.is_gateway_host = false

    /** @type {boolean} If true, this is a websocket request*/
    this.is_websocket_request = false

    /** @type {string} An identifier for the target. Generated via a general call.*/
    this.target_id = null

    /**
     * @type {string} The domain suffix for the gateway
     */
    this.gateway_domain_postfix = null

    /** @type {string} The method to use when calling the target */
    this.target_method = null

    /** @type {URL} The backend url to call on.*/
    this.backend_url = null
  }
}

class GatewayBackendParser {
  /**
   * Parses the backend url request from the current path.
   * @param {{
   * parse_url_from_id: (gateway:Gateway, req: Request, target_id)=>string,
   * parse_url_from_route: (gateway:Gateway, req: Request)=>string,
   * parse_protocol: (gateway:Gateway, req: Request)=>string,
   * parse_method:(gateway:Gateway, req: Request)=>string,
   * }} param0
   */
  constructor({
    parse_url_from_id = null,
    parse_url_from_route = null,
    parse_protocol = null,
    parse_method = null,
  } = {}) {
    this.invoke_methods = {
      parse_url_from_id,
      parse_url_from_route,
      parse_protocol,
      parse_method,
    }
  }

  /**
   * Parse the hostname/domain from the host id and return
   * the new url.
   * @param {Gateway} gateway
   * @param {Request} req
   * @param {string} target_id
   */
  parse_url_from_id(gateway, req, target_id) {
    if (this.invoke_methods.parse_url_from_id)
      return this.invoke_methods.parse_url_from_id(gateway, req, target_id)
    // general case the id is the remote host + port
    const parsed_from_id = req.protocol + '://' + target_id + req.originalUrl
    const url = new URL(parsed_from_id)
    return url
  }

  /**
   * Parse the hostname/domain from the route and the return
   * the new url.
   * @param {Gateway} gateway
   * @param {Request} req
   */
  parse_url_from_route(gateway, req) {
    if (this.invoke_methods.parse_url_from_route)
      return this.invoke_methods.parse_url_from_route(gateway, req)

    const request_path = req.originalUrl.substr((req.baseUrl || '').length)
    const url = new URL(req.protocol + '://' + request_path)
    return url
  }

  /**
   * Returns the protocol to use when parsing a request.
   * @param {Gateway} gateway
   * @param {Request} req
   */
  parse_protocol(gateway, req) {
    if (this.invoke_methods.parse_protocol)
      return this.invoke_methods.parse_protocol(gateway, req)

    let target_protocol = req.protocol
    if (gateway.force_protocol != null) target_protocol = gateway.force_protocol
    // if (this.is_websocket_request && gateway.force_websocket_protocol)
    //     target_protocol = gateway.force_http || req.protocol != 'https' ? 'ws' : 'wss'
    if (gateway.force_http && target_protocol == 'https')
      target_protocol = 'http'

    return target_protocol
  }

  /**
   * Returns the http method to use when applying the protocol.
   * @param {Gateway} gateway
   * @param {Request} req
   */
  parse_method(gateway, req) {
    if (this.invoke_methods.parse_method)
      return this.invoke_methods.parse_method(gateway, req)
    return req.method
  }
}

/**
 * @typedef {(event: 'error', listener: (error: Error) => void) => this} GatewayEventListenError
 * @typedef {(event: 'log', listener: (level:string, ...args) => void) => this} GatewayEventListenLog
 * @typedef {GatewayEventListenError & GatewayEventListenLog} GatewayEventListenRegister
 */

/**
 * @typedef {(event: 'error', error:Error) => this} GatewayEventEmitError
 * @typedef {(event: 'log', level:'DEBUG'|'INFO'|'WARN'|'ERROR', ...args) => this} GatewayEventEmitLog
 * @typedef {GatewayEventEmitError & GatewayEventEmitLog} GatewayEventEmitter
 */

/**
 * Defines a request filter with a backend request. The filter allows
 * the active filtering of backend requests. parameter backend_url only exists in
 * a subdomain gateway request.
 * @typedef {(info:GatewayRequestInfo, req:Request, res:Response, next:NextFunction)=>boolean} GatewayRequestFilter
 */

class Gateway extends events.EventEmitter {
  /**
   * @param {{
   * gateway_host: string,
   * force_protocol: string,
   * force_http: boolean
   * force_websocket_protocol: boolean,
   * gateway_subdomain: string,
   * logger: Console,
   * log_errors_to_console:boolean,
   * }} param0
   */
  constructor({
    gateway_host = null,
    force_protocol = null,
    force_http = true,
    force_websocket_protocol = true,
    gateway_subdomain = 'gateway-proxy',
    socket_ports = [22],
    logger = null,
    log_errors_to_console = true,
  } = {}) {
    super()

    this.gateway_host = gateway_host
    this.force_protocol = force_protocol
    this.force_http = force_http
    this.force_websocket_protocol = force_websocket_protocol
    this.gateway_subdomain = gateway_subdomain
    this.socket_ports = socket_ports

    /**@type {GatewayEventListenRegister} */
    this.on
    /**@type {GatewayEventListenRegister} */
    this.once

    /**@type {GatewayEventEmitter} */
    this.emit

    if (logger) {
      this.on('log', (level, ...args) => {
        logger[level.toLowerCase()](...args)
      })
    }

    this.on('error', (err) => {
      if (logger && logger.error) logger.error(err)
      if (log_errors_to_console) console.error(err)
    })
  }

  /**
   * Create a proxy request for the info.
   * @param {Error} err
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @param {GatewayRequestInfo} info
   */
  _handle_proxy_request_error(err, req, res, next, info) {
    const originalCode = err.code || '[unknown]'
    const status = map_dns_status_to_http_code(originalCode)

    if (status == 500)
      this.emit(
        'log',
        'ERROR',
        `Backend service error while executing request (${status}): ` +
          err.message
      )

    if (info.is_websocket_request) return res.sendStatus(status)
    err.code = status
    err.statusCode = status
    err.originalCode = originalCode
    next(err)
  }

  /**
   * Create a proxy request for the info.
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @param {GatewayRequestInfo} info
   * @param {(res:http.IncomingMessage)=>{}} handle_response
   * @returns {http.ClientRequest}
   */
  create_proxy_request(
    req,
    res,
    next,
    info,
    handle_response = null,
    headers = null,
    override_headers = false
  ) {
    /**
     * @type {http.RequestOptions}
     */
    const options = {
      method: info.target_method,
      protocol: info.backend_url.protocol,
      hostname: info.backend_url.hostname,
      port: info.backend_url.port,
      path: info.backend_url.pathname + info.backend_url.search,
    }

    options.headers = {
      ...(override_headers ? {} : req.headers),
      ...(headers || {}),
    }

    // reset the host if self redirect
    if ((options.headers.host || '').endsWith(info.backend_url.host))
      options.headers.host = null

    let proxy_request = null
    switch (info.backend_url.protocol) {
      case 'wss:':
      case 'https:':
        {
          proxy_request = https.request(options, handle_response)
        }
        break
      default:
        {
          proxy_request = http.request(options, handle_response)
        }
        break
    }

    proxy_request.on('error', (err) => {
      this.emit('error', err)
      this._handle_proxy_request_error(err, req, res, next, info)
    })

    return proxy_request
  }

  /**
   * A middleware function to execute the auth.
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @param {GatewayRequestInfo} info
   */
  send_proxy_request(req, res, next, info) {
    const proxy_request = this.create_proxy_request(
      req,
      res,
      next,
      info,
      (proxy_rsp) => {
        res.writeHead(proxy_rsp.statusCode, proxy_rsp.headers)
        proxy_rsp.pipe(res, {
          end: true,
        })
      }
    )

    req.pipe(proxy_request, {
      end: true,
    })
  }

  /**
   * A middleware function to execute the auth.
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @param {GatewayRequestInfo} info
   */
  create_websocket_proxy(req, res, next, info) {
    try {
      const client_socket = req.socket
      client_socket.setTimeout(0)
      client_socket.setNoDelay(true)
      client_socket.setKeepAlive(true, 0)

      const ws_request = this.create_proxy_request(req, res, next, info)

      const create_websocket_socket_header = (...args) => {
        let lines = []
        for (let v of args) {
          if (Array.isArray(v)) {
            lines = lines.concat(v)
          }
          if (typeof v == 'object') {
            for (let key of Object.keys(v)) {
              let ov = v[key]
              if (Array.isArray(ov))
                ov.forEach((v) => {
                  lines.push(key + ': ' + value[i])
                })
              else lines.push(key + ': ' + ov)
            }
          } else lines.push(v)
        }
        return lines.join('\r\n') + '\r\n\r\n'
      }

      ws_request.on('response', (proxy_rsp) => {
        if (proxy_rsp.upgrade == true) {
          res.writeHead(proxy_rsp.statusCode, proxy_rsp.headers)
          proxy_rsp.pipe(res)
        } else {
          this.emit(
            'log',
            'WARN',
            `Websocket proxy @ ${info.backend_url} denied the websocket.`
          )
          res.send('denied')
        }
      })

      ws_request.on('upgrade', (proxy_rsp, proxy_socket, proxy_head) => {
        proxy_socket.on('error', (err) => {
          this.emit('error', err)
          this.emit('log', 'ERROR', 'Proxy socket error')
        })

        if (proxy_head && proxy_head.length) proxy_socket.unshift(proxy_head)

        proxy_socket.on('close', () => {
          client_socket.end()
        })

        client_socket.on('close', () => {
          proxy_socket.end()
        })

        // keep the proxy socket active.
        proxy_socket.setKeepAlive(true, 0)
        proxy_socket.setNoDelay(true, 0)
        proxy_socket.setTimeout(0)

        client_socket.write(
          create_websocket_socket_header(
            'HTTP/1.1 101 Switching Protocols',
            proxy_rsp.headers
          )
        )

        proxy_socket.pipe(client_socket).pipe(proxy_socket)
      })

      req.pipe(ws_request)
    } catch (err) {
      this.emit('error', err)
      this.emit('log', 'ERROR', 'Proxy websocket setup with error')
    }
  }

  /**
   * A middleware function to execute the auth.
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @param {GatewayRequestInfo} info
   */
  create_socket_tunnel(req, res, next, info) {
    const client_socket = req.socket
    const proxy_socket = new net.Socket({
      allowHalfOpen: true,
      readable: true,
      writable: true,
    })

    const handle_error = (err) => {
      try {
        proxy_socket.end()
        client_socket.end()
      } catch {}

      this.emit('error', err)
      this._handle_proxy_request_error(err, req, res, next, info)
    }

    proxy_socket.on('connect', () => {
      // piping
      proxy_socket.pipe(client_socket).pipe(proxy_socket)
      proxy_socket.on('close', () => {
        client_socket.end()
      })
      client_socket.on('close', () => {
        proxy_socket.end()
      })
    })

    proxy_socket.connect({
      port: info.backend_url.port,
      host: info.backend_url.host,
    })

    proxy_socket.on('error', handle_error)
    client_socket.on('error', handle_error)
  }

  /**
   * Call to auto detect gateway host.
   * @param {Request} req
   */
  get_gateway_host(req) {
    if (this.gateway_host != null) return this.gateway_host

    // auto-detect
    const host = req.get('host')
    const subdomain_prefix = `.${this.gateway_subdomain}.`
    const last_index = host.lastIndexOf(subdomain_prefix)
    if (last_index == -1) {
      // assume not a direct gateway call.
      return host
    } else {
      return host.substr(last_index + subdomain_prefix.length)
    }
  }

  /**
   * @param {Request} req
   * @param {GatewayRequestInfo} info
   * @returns {string} The host redirect
   */
  get_gateway_host_redirect(req, info) {
    const redirect_host = this.get_gateway_host(req)
    return (
      info.backend_url.protocol +
      '//' +
      encode_hostname(info.target_id) +
      '.' +
      this.gateway_subdomain +
      '.' +
      redirect_host +
      info.backend_url.pathname +
      info.backend_url.search
    )
  }

  /**
   * @param {GatewayBackendParser | (gateway:Gateway, req: Request)=>string} parser
   * @returns {GatewayBackendParser}
   */
  _validate_parser(parser) {
    assert(parser != null, 'Parser must not be null')
    if (!(parser instanceof GatewayBackendParser)) {
      assert(
        typeof parser == 'function',
        'the parser must be a function or of type GatewayRequestParser'
      )

      parser = new GatewayBackendParser({
        parse_url_from_route: parser,
      })
    }
    return parser
  }

  /**
   * Parse the basic request parameters.
   * @param {GatewayBackendParser} parser
   * @param {GatewayRequestInfo} info
   * @param {Request} req
   */
  _parse_request_core_info(parser, info, req) {
    const req_host = req.get('host')
    info.gateway_domain_postfix =
      this.gateway_subdomain + '.' + this.get_gateway_host(req)

    info.is_gateway_host = req_host.endsWith(info.gateway_domain_postfix)
    info.is_websocket_request =
      req.headers['sec-websocket-protocol'] != null ||
      req.headers.upgrade == 'websocket'

    if (info.is_gateway_host) {
      info.target_id = decode_hostname(
        req_host.substr(
          0,
          req_host.length - info.gateway_domain_postfix.length - 1
        )
      )

      info.backend_url = parser.parse_url_from_id(this, req, info.target_id)
    }
  }

  /**
   * Parse the basic request parameters.
   * @param {GatewayBackendParser} parser
   * @param {GatewayRequestInfo} info
   * @param {Request} req
   */
  _parse_request_intercept_info(parser, info, req) {
    // try intercept if not ignored by filter.
    info.is_gateway_intercept = true

    if (info.is_gateway_host != true) {
      // case a gateway request. No id.
      info.backend_url = parser.parse_url_from_route(this, req)
    }

    if (info.backend_url == null) {
      info.is_gateway_intercept = false
    } else {
      info.backend_url =
        info.backend_url instanceof URL
          ? info.backend_url
          : new URL(info.backend_url)
      info.target_id = info.target_id || info.backend_url.host

      assert(
        info.backend_url != null,
        'Target url not defined or target url not resolved'
      )

      info.target_method = parser.parse_method(this, req)
      info.backend_url.protocol = parser.parse_protocol(this, req)

      if (info.is_websocket_request) {
        info.backend_url.pathname = info.backend_url.pathname.replace(
          /\/[.]websocket$/,
          ''
        )
      }
    }
  }

  /**
   * @param {GatewayBackendParser | (gateway:Gateway, req: Request)=>string} parser
   * @param {GatewayRequestFilter} request_filter
   */
  middleware(parser, request_filter = null) {
    parser = this._validate_parser(parser)

    /**
     * A middleware function to execute the auth.
     * @param {Request} req
     * @param {Response} res
     * @param {NextFunction} next
     */
    const run_middleware = async (req, res, next) => {
      let is_next_override = false
      let next_override_result = null
      const next_with_override = (...args) => {
        is_next_override = true
        next_override_result = next(...args)
        return next_override_result
      }

      try {
        const info = new GatewayRequestInfo()
        this._parse_request_core_info(parser, info, req)

        // checking the filter.
        const is_allowed =
          request_filter != null
            ? request_filter(info, req, res, next_with_override) === false
              ? false
              : true
            : true

        if (!is_allowed || is_next_override) {
          if (!is_next_override) return next()
          else return next_override_result
        }

        // complete the information after the filter.
        this._parse_request_intercept_info(parser, info, req)

        // skip if not a gateway request.
        if (!info.is_gateway_intercept) return next()

        // websocket/socket request do not require their own domain.
        if (info.is_websocket_request) {
          this.emit(
            'log',
            'INFO',
            `Starting websocket proxy ${req.originalUrl} -> ${info.backend_url}`
          )
          this.create_websocket_proxy(req, res, next, info)
          return
        }

        // any other web request should be redirected.
        if (!info.is_gateway_host) {
          const redirect_path = this.get_gateway_host_redirect(req, info)
          this.emit('log', 'INFO', 'Redirect: ' + redirect_path)
          res.redirect(redirect_path)
          return
        }

        this.send_proxy_request(req, res, next, info)
      } catch (err) {
        this.emit('error', err)
        this.emit(
          'log',
          'ERROR',
          'Error while processing proxy request: ' + (err.message || 'No text')
        )
        res.sendStatus(500)
        return
      }
    }

    return run_middleware
  }
}

module.exports = {
  decode_hostname,
  encode_hostname,
  Gateway,
  GatewayRequestParser: GatewayBackendParser,
  GatewayRequestInfo,
}
