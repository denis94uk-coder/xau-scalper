/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_PREVIEW: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
