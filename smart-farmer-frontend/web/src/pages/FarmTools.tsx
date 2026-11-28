import type {Page} from '../context';
import {Advisor,BasicPhone,GrowingSystems,MarketPrices,Sensors,Support,Trials} from './farm-tools';
export default function FarmTools({page}:{page:Page}) {
  if(page==='sensors')return <Sensors/>;
  if(page==='market-prices')return <MarketPrices/>;
  if(page==='support')return <Support/>;
  if(page==='trials')return <Trials/>;
  if(page==='growing-systems')return <GrowingSystems/>;
  if(page==='advisor')return <Advisor/>;
  if(page==='basic-phone')return <BasicPhone/>;
  return null;
}
