// 第三方库类型声明（upng-js 无自带类型）
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
