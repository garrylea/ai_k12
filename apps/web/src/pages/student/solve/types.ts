/** 状态 A 录入的一张待识别题图（spec §8.3）。 */
export interface SourceImage {
  localId: string;
  fileName: string;
  previewUrl: string;
  status: 'converting' | 'uploading' | 'ready' | 'error';
  fileId?: string;
  url?: string;
  error?: string;
}
