declare module "*.css";

declare module "*.html" {
  const html: string;
  export default html;
}

interface ImportMeta {
  hot?: {
    data: Record<string, unknown>;
  };
}
