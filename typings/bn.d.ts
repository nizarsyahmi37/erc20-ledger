declare module "bn.js" {
  class BN {
    constructor(number: any, base?: number);
    toString(base?: number): string;
  }
  export = BN;
}
