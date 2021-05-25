const path = require('path')
const http = require('http')
const { websocket } = require('@lamaani/stratis')
const { Gateway } = require('./gateway')
const { Logger } = require('@lamaani/infer')
const express = require('express')

const app = express()
const log = new Logger('gateway-test')
const httpServer = http.createServer(app)
const gateway = new Gateway({ logger: log })
let query_index = 0

let port = 3000
if (process.argv.length > 2) port = parseInt(process.argv[2])

app.use((req, rsp, next) => {
  log.info(
    `${req.get('host')}${req.originalUrl} (${(query_index + '').padStart(
      5,
      '0'
    )})`,
    '->'.cyan
  )
  query_index++
  next()
})

// app.set('etag', false)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

app.get('/favicon.ico', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'www', 'favicon.ico'))
})

app.use(
  gateway.middleware(
    (gateway, req) => {
      const gateway_request_path = req.originalUrl.substr(
        req.baseUrl.length + '/gateway'.length
      )
      const domain = gateway_request_path.startsWith('/err-dns/')
        ? 'not-a-real-dns-name-this-should-not-be-valid'
        : 'localhost'

      const backend_url = `http://${domain}:${port}` + gateway_request_path
      log.info('Redirect: ' + backend_url)
      return backend_url
    },
    (info, req, res, next) => {
      if (!info.is_gateway_host) return req.path.startsWith('/gateway')
    }
  )
)

app.use(
  '/echo/ws',
  websocket((ws, req) => {
    ws.on('message', (msg) => {
      ws.send('echo: ' + msg)
    })
  })
)

app.use('/echo/*', (req, rsp, next) => {
  log.info('Echo: ' + req.originalUrl)
  rsp.send('Echo: ' + req.originalUrl)
})

app.get('*', (req, rsp, next) => {
  log.info('Catchall: ' + req.originalUrl)
  rsp.sendStatus(404)
})

app.use((err, req, res, next) => {
  if (typeof err.code == 'number') {
    return res.status(err.code).send
  }
  next(err)
})

httpServer.listen(port)
log.info(`Listening @ http://localhost:${port}`)
console.log()

log.info(`Echo request @ http://localhost:${port}/echo/echome?lama=kka`)
log.info(`Echo websocket @ ws://localhost:${port}/echo/ws`)
console.log()
log.info(`Test echo @ @ http://localhost:${port}/gateway/echo/echome?lama=kka`)
log.info(`Test echo ws @ ws://localhost:${port}/gateway/echo/ws`)
console.log()
log.info(`Test dns @ http://localhost:${port}/gateway/err-dns/echome?lama=kka`)
log.info(`Test dns ws @ ws://localhost:${port}/gateway/err-dns/ws`)
