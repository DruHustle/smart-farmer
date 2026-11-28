/** Photo compaction is local. Upload starts only after the user submits with consent. */
export async function compactAdvisorPhoto(file: File): Promise<{mimeType: 'image/jpeg'; base64: string}> {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('attachment_type');
  if (file.size > 20 * 1024 * 1024) throw new Error('attachment_too_large');
  const bitmap = await createImageBitmap(file);
  try {
    const scale=Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');if(!context)throw new Error('attachment_type');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    for(const quality of [.82,.65,.45]) {
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if(!blob||blob.size>1.5*1024*1024)continue;
      const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      return {mimeType:'image/jpeg',base64:btoa(binary)};
    }
    throw new Error('attachment_too_large');
  }finally{bitmap.close();}
}
