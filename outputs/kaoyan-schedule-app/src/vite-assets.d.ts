declare module '*?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly VITE_NOTE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
