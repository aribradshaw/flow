// Flygon Flow's brand for OneMail (@aribradshaw/onemail), the shared email layout the invite uses.
// Brand data lives here; OneMail holds only the engine.
//
// Colours are the Flygon ones the invite has always used (@flygon/styles): brick button, dark-green
// links, a soft grey-green page. The logo is Flow's diamond mark plus the "Flygon Flow" wordmark,
// public/email/flow-logo@2x.png (and a light-on-dark variant), 336x88 shown at 168x44. Each
// instance serves it from its own public URL, so the logo is only used when that URL is https
// (OneMail requires https images); a plain-http dev instance shows the name as text instead.
// Sending uses FLOW_EMAIL_FROM (lib/mailer.mjs); `from` here is not used to send.
import {defineBrand} from '@aribradshaw/onemail';

export const LOGO_PATH='/email/flow-logo@2x.png',LOGO_DARK_PATH='/email/flow-logo-dark@2x.png';

export function flowBrand(appUrl){
  const origin=String(appUrl||'').replace(/\/+$/,'');
  const https=/^https:\/\/[^/]+/.test(origin),web=/^https?:\/\/[^/]+/.test(origin);
  return defineBrand({
    name:'Flygon Flow',
    ...(https?{logoUrl:origin+LOGO_PATH,logoDarkUrl:origin+LOGO_DARK_PATH,logoWidth:168,logoHeight:44}:{}),
    fontFamily:'Segoe UI, Helvetica, Arial, sans-serif',
    colors:{
      primary:'#a8524c',link:'#324b34',text:'#1d2725',muted:'#66726e',background:'#f6f7f6',surface:'#ffffff',border:'#e3e7e5',buttonText:'#ffffff',
      dark:{primary:'#a8524c',link:'#d1ecb0',text:'#f1f6f1',muted:'#bfe2c1',background:'#1b261c',surface:'#243325',border:'#324b34',buttonText:'#ffffff'},
    },
    from:{name:'Flygon Flow',email:'flow@example.com'},
    footer:{
      legalName:'Flygon LC',
      address:['13236 N 7th St, Unit 4, PMB 811','Phoenix, AZ 85022'],
      ...(web?{website:origin}:{}),
    },
  });
}
