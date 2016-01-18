// Deliberately minimal ambient declarations for the Node 4 APIs this project uses
// (stands in for DefinitelyTyped's node.d.ts, which is far larger than we need).
declare var require: any;
declare var module: any;
declare var process: any;
declare var __dirname: string;
declare var Buffer: any;

declare module "http" {
  export function createServer(handler: (req: any, res: any) => void): any;
  export function request(options: any, cb: (res: any) => void): any;
}
declare module "https" {
  export function request(options: any, cb: (res: any) => void): any;
}
declare module "url" {
  export function parse(url: string, parseQueryString?: boolean): any;
}
declare module "crypto" {
  export function createHash(algorithm: string): any;
}
declare module "fs" {
  export function readdir(path: string, cb: (err: any, files: string[]) => void): void;
  export function readFile(path: string, encoding: string, cb: (err: any, data: string) => void): void;
}
declare module "path" {
  export function join(...parts: string[]): string;
}
declare module "assert" {
  var assert: any;
  export = assert;
}
