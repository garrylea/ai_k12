/**
 * HEIC/HEIF -> JPEG conversion utility.
 *
 * heic2any is a large WASM library and MUST be dynamically imported
 * so it is code-split out of the initial bundle. Only files that are
 * actually HEIC/HEIF trigger the import; PNG/JPEG pass through untouched.
 */
export async function ensureJpeg(file: File): Promise<File> {
  const isHeic =
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.heic$/i.test(file.name) ||
    /\.heif$/i.test(file.name);
  if (!isHeic) return file;

  const heic2any = (await import('heic2any')).default;
  const result = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.8,
  });
  // heic2any returns Blob | Blob[] depending on `multiple` flag (not set here,
  // so a single Blob is expected). Handle both defensively.
  const blob: Blob | undefined = Array.isArray(result) ? result[0] : result;
  if (!blob) throw new Error('HEIC conversion returned empty result');
  const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
  return new File([blob], newName, { type: 'image/jpeg' });
}
