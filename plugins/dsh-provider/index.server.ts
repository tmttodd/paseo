import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDshProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDshProvider());
  return () => {};
}
