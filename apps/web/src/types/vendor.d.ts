declare module 'diff' {
  export function diffLines(oldStr: string, newStr: string): Array<{ value: string; added?: boolean; removed?: boolean }>;
  export function createTwoFilesPatch(
    oldFileName: string, newFileName: string, oldStr: string, newStr: string,
    oldHeader?: string, newHeader?: string, options?: { context?: number },
  ): string;
}
