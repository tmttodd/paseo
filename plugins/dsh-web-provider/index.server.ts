import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDshWebProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDshWebProvider());
  return () => {};
}
