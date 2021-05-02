const express = require('express')
const { Gateway } = require('../../gateway')
const { Logger } = require('@lamaani/infer')

const log = new Logger('gateway')
const gateway = new Gateway({
  logger: log,
})

const app = express()

// using a localhost parser.
app.use(
  // (NOTE! you cannot use filtering in the
  // app.use since these subpaths may be required for the backend)
  gateway.middleware(
    (gateway, req) => {
      // mapping function. Map a request path to an internal network url.
      // Can be used to map multiple services.

      // For the example point to the website at localhost:8080
      return 'http://localhost:3030/' + req.path.split('/').slice(1).join('/')
    },
    (req) => {
      // Filter method. Used to allow specific urls.
      // otherwise the gateway will move next.

      // For the example all paths backend/
      return req.path.match(/^\/?backend\/?/)
    }
  )
)

app.get('*', (req, res) => {
  log.info('Unknown ' + req.originalUrl, '?'.yellow)
  res.sendStatus(404)
})

module.exports = {
  app,
}

if (require.main == module) {
  port = 8080
  app.listen(port, () => {
    log.info(`Gateway listening on http://localhost:${port}/backend`)
  })
}
