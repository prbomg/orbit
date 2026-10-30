import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiError, ApiError, json, readBody } from '@/lib/api';
import { saveProjectOrder } from '@/utils/projectOrder';
import { z } from 'zod';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const schema=z.object({ids:z.array(z.string().min(1).max(128)).max(10000),archived:z.boolean()}).strict();
async function PATCHHandler(request:Request){
 try{
  const {ids,archived}=schema.parse(await readBody(request));
  await prisma.$transaction(tx=>saveProjectOrder(tx,ids,archived),{timeout:15000});
  return json({saved:true});
 }catch(error){
  if(error instanceof Error&&error.message==='order_changed')return apiError(new ApiError(409,'Список проектов изменился. Обновите страницу и повторите.'));
  if(error instanceof Error&&error.message==='invalid_order')return apiError(new ApiError(400,'Проекты в порядке не должны повторяться.'));
  return apiError(error);
 }
}
export const PATCH=withAuth(PATCHHandler);
