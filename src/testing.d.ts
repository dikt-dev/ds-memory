/**
 * vitest 里做源码静态检查要用到的一点 Node API。
 *
 * 这个项目只跑在 Workers 上，没装 @types/node；为了不为一处测试引入整套
 * node 类型，这里只声明用到的几个函数（运行期由 vitest 提供）。
 */
declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function statSync(path: string): { isDirectory(): boolean };
  export function existsSync(path: string): boolean;
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare const process: { cwd(): string };
