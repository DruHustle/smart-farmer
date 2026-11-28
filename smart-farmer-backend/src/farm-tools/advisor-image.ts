import sharp from 'sharp';
import {ApiError} from '../context.js';

/** Validate, resize and strip metadata before an explicitly consented provider call.
 * Images stay in request memory; neither original nor base64 is logged or stored.
 */
export async function advisorImage(input:{mimeType:string;base64:string}){
  if(input.base64.length>2_097_152||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)||input.base64.length%4!==0)throw new ApiError('invalid_advisor_image');
  const raw=Buffer.from(input.base64,'base64');
  if(!raw.length||raw.length>1_572_864||raw.toString('base64')!==input.base64)throw new ApiError('invalid_advisor_image');
  try{
    const image=sharp(raw,{limitInputPixels:20_000_000,animated:false,failOn:'error'});
    const metadata=await image.metadata();
    const mime:Record<string,string>={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
    if(mime[metadata.format??'']!==input.mimeType||(metadata.pages??1)!==1)throw new ApiError('invalid_advisor_image');
    const normalized=await image.rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).jpeg({quality:78}).toBuffer();
    return 'data:image/jpeg;base64,'+normalized.toString('base64');
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError('invalid_advisor_image');}
}
