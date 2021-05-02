const path = require("path");
const http = require("http");
const { websocket } = require("@lamaani/stratis");
const { Gateway } = require("./gateway");
const { Logger } = require("@lamaani/infer");

const log = new Logger("gateway-test");
const httpServer = http.createServer(app);
const gateway = new Gateway({ logger: log });


let port = 3000;
if (process.argv.length > 2) port = parseInt(process.argv[2]);

app.use((req, rsp, next) => {
  log.info(req.get("host") + req.originalUrl, "->".cyan);
  next();
});

// app.set('etag', false)
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/favicon.ico", (req, res, next) => {
  res.sendFile(path.join(__dirname, "www", "favicon.ico"));
});

app.use(
  "/gateway",
  gateway.middleware((gateway, req) => {
    const gateway_request_path = req.originalUrl.substr(req.baseUrl.length);
    const redirect_url = `http://localhost:${port}/echo` + gateway_request_path;
    log.info("Redirect: " + redirect_url);
    return redirect_url;
  })
);

app.use(
  "/echo/ws",
  websocket((ws, req) => {
    ws.on("message", (msg) => {
      ws.send("echo: " + msg);
    });
  })
);

app.use("/echo/*", (req, rsp, next) => {
  log.info("Echo: " + req.originalUrl);
  rsp.send("Echo: " + req.originalUrl);
});

app.get("*", (req, rsp, next) => {
  info.log("Catchall: " + req.originalUrl);
  rsp.send("Nada");
});

httpServer.listen(port);
log.info(`Listening @ http://localhost:${port}`);
log.info(
  `Gateway @ http://localhost:${port}/gateway/test_echo/echome?lama=kka`
);
log.info(`Gateway websocket @ ws://localhost:${port}/gateway/ws`);
log.info(`Echo websocket @ ws://localhost:${port}/echo/ws`);
log.info(`Echo request @ http://localhost:${port}/echo`);
