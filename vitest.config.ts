import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineWorkersConfig({
    test: {
        globals: true,
        include: ["sources/**/*.test.ts", "sources/**/*.spec.ts"],
        exclude: ["node_modules/**", "dist/**"],
        poolOptions: {
            workers: {
                wrangler: {
                    configPath: "./wrangler.toml",
                },
                miniflare: {
                    // Add test-specific bindings here
                    kvNamespaces: ["CACHE"],
                    d1Databases: ["DB"],
                    r2Buckets: ["FILES"],
                },
            },
        },
    },
    plugins: [tsconfigPaths()],
});
