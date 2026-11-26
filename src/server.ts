import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";

const config = readConfig(process.env);
const server = createApp(config).listen(config.PORT, "0.0.0.0", () => {
  console.log(`Catalogue API listening on port ${config.PORT}`);
});
process.once("SIGTERM", () => server.close());
