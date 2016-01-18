// node-postgres 4.x: callback API with a global, per-connection-string pool.
declare module "pg" {
  export var defaults: any;
  export function connect(conString: string, cb: (err: any, client: any, done: (destroy?: any) => void) => void): void;
  export function end(): void;
}
