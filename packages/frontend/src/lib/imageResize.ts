// Shrinks a camera photo on the phone before it is beamed to the TV:
// longest side 640 px, JPEG at 0.72 quality (roughly 40-80 KB).
const MAX_SIDE = 640;
const JPEG_QUALITY = 0.72;

export async function compressPhoto(file: File): Promise<string> {
  // imageOrientation applies the EXIF rotation so portrait shots stay upright
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('JPEG encoding unavailable');
    return dataUrl;
  } finally {
    bitmap.close();
  }
}
