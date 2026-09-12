// Ambient type for Bun's file-import embedding (`with { type: 'file' }`):
// the import resolves to a filesystem path to the embedded asset.
declare module '*.wasm' {
  const path: string;
  export default path;
}
