interface ImportMetaEnv {
  readonly VITE_NEORESEARCH_SERVER_HOST: string
  readonly VITE_NEORESEARCH_SERVER_PORT: string
  readonly VITE_NEORESEARCH_CHANNEL?: "dev" | "beta" | "prod"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
