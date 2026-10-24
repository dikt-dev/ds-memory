// 第三方库类型声明（upng-js 无自带类型）
// Vite / Vitest 的 ?raw 导入（schema 测试用）
declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'upng-js' {
  interface UPNGImage {
    width: number;
    height: number;
  }
  const UPNG: {
    decode(buf: ArrayBuffer | Uint8Array): UPNGImage;
    toRGBA8(img: UPNGImage): ArrayBuffer[];
  };
  export default UPNG;
}
