declare module "eslint-plugin-security" {
  const plugin: {
    rules: Record<string, unknown>;
    configs?: Record<string, unknown>;
  };
  export default plugin;
}
