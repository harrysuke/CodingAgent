declare module 'diff' {
  export interface PatchOptions { context?: number }
  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: PatchOptions,
  ): string;
  export function createPatch(fileName: string, oldStr: string, newStr: string, oldHeader?: string, newHeader?: string, options?: PatchOptions): string;
  export function diffLines(oldStr: string, newStr: string): Array<{ value: string; added?: boolean; removed?: boolean }>;
}
