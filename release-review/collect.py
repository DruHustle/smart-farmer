"""Assemble a read-only release review from known CI runs and an explicit screenshot allowlist."""
import hashlib
import html
import json
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

REPO = 'DruHustle/smart-farmer'
FARMER = '129b7560ba891255bd940f9ac8f95d956b625c88'
PORTAL = 'e8c4544b50648425c0948914505fab1617e3b3f9'
QA = '62c6d03513be560c486e374ebaa37a0ededfaf3a'
REVIEW = Path('qualification-output')
PACKAGES = Path('verified-packages')
REVIEW.mkdir(exist_ok=True)
PACKAGES.mkdir(exist_ok=True)
report = json.loads(Path('release-review/observations.json').read_text())
receipts = {'archives': [], 'jobs': [], 'nativeSuites': [], 'screenshotSources': [], 'browserGroups': [], 'accessibility': {}}
figures = []

def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/' + REPO + path]))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def source_artifact(run, entry):
    url = 'https://github.com/' + REPO + '/actions/runs/' + str(run) + '/artifacts/' + str(entry['id'])
    return {'run': run, 'artifact': entry['id'], 'name': entry['name'], 'url': url, 'sha256': entry['digest'].removeprefix('sha256:')}

def add_screen(raw, name, caption, source):
    if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Invalid PNG from ' + name)
    path = REVIEW / 'screenshots' / name
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(raw)
    info = {'file':str(path.relative_to(REVIEW)), 'caption':caption, 'sha256':digest(raw), **source}
    receipts['screenshotSources'].append(info)
    figures.append(info)

WEB_IMAGES = {
    'accounting-small-phone-actions-viewport.png':'Settled sales invoice, narrow Shona web viewport',
    'market-discovery-nd-1280.png':'Marketplace and saved searches, desktop isiNdebele web viewport',
    'small-phone-notifications.png':'Notifications on a small phone web viewport',
    'desktop-notifications.png':'Notifications on a desktop web viewport',
    'accounting-tablet-sn.png':'Accounting on a tablet web viewport in Shona',
    'tracking-nd-320.png':'Tracker status on a narrow isiNdebele web viewport'
}
SAFE_TEXT = {
    'android-entry.txt','android-display.txt','android-results.txt','ios-results.txt',
    'android-exactly-once.txt','android-encryption.txt','android-product-records.txt','android-intake-checks.txt','android-intake-encryption.txt',
    'ios-exactly-once.txt','ios-encryption.txt','ios-product-records.txt','ios-intake-checks.txt','ios-intake-encryption.txt'
}
HISTORIC_IOS = {
  'ios-login/login/screenshots/step-018-tapOnElement-^Continue$.png':'iPhone Shona login with keyboard, earlier iOS simulator',
  'ipad-large-font/login/screenshots/step-018-tapOnElement-^Continue$.png':'iPad large-text Shona login, earlier iPadOS simulator',
  'ipad-large-font/login/screenshots/step-036-assertCondition-tab-record.png':'iPadOS Save Password prompt at the earlier failed assertion'
}
BUNDLES = {
    'ios':('SmartFarmer-unsigned.xcarchive.zip','e0c4d76137faf976b691de3500b7591a92940abd98df48c047a6251fbbcfb494','Smart-Farmer-iOS-0.2.0-1-unsigned.xcarchive.zip'),
    'android':('SmartFarmer-qualification.aab','8c1d31bb1e6f14a1f3e28b3a8bc7b0a1d4908a429a736f66d61316a98e4c6b35','Smart-Farmer-Android-0.2.0-1-test-signed.aab')
}

def harvest(z, source, tag, kind):
    folder = REVIEW / 'receipts' / tag
    folder.mkdir(parents=True, exist_ok=True)
    if kind in BUNDLES:
        expected, checksum, out = BUNDLES[kind]
        name, = [n for n in z.namelist() if Path(n).name == expected]
        data = z.read(name)
        assert digest(data) == checksum
        (PACKAGES/out).write_bytes(data)
        for n in z.namelist():
            if Path(n).name in {'manifest.json','SHA256SUMS'}:
                (folder/Path(n).name).write_bytes(z.read(n))
        return
    if kind == 'web':
        result = json.loads(z.read('results.json'))
        assert result['status'] == 'passed' and len(result['passed']) == 34
        (folder/'results.json').write_bytes(z.read('results.json'))
        receipts['browserGroups'] = result['passed']
        for n in z.namelist():
            if n in WEB_IMAGES:
                add_screen(z.read(n),tag+'-'+n,WEB_IMAGES[n],source)
            if re.fullmatch(r'axe-[A-Za-z0-9-]+\.json',n):
                payload=json.loads(z.read(n))
                violations=payload['violations'] if isinstance(payload,dict) else payload
                receipts['accessibility'][n]=len(violations)
        assert len(receipts['accessibility'])==12 and not any(receipts['accessibility'].values())
        return
    emitted = set()
    for n in z.namelist():
        leaf = Path(n).name
        if '/' not in n and n in SAFE_TEXT:
            (folder/n).write_bytes(z.read(n))
        if re.fullmatch(r'(?:android|ios|ipad)-(?:login|offline|reconcile|products|intake-(?:capture|upload|review|post)|large-font)\.xml',n):
            xml=ET.fromstring(z.read(n))
            tests = list(xml.iter('testcase'))
            def count(name):
                return sum(any(child.tag==name for child in t) for t in tests)
            error_msg=' '.join(' '.join(list(node.attrib.values()))+' '+(node.text or '') for node in xml.iter() if node.tag in ('failure','error'))
            safe_markers=[label for label in ('tab-record','auth-username','auth-password','auth-submit','device-reauthenticate','auth-onesa','tab-more','workspace-language','more-finance','finance-tabs','accounting-tabs','invoice-library','PXGGridLayout-Info','invoice-local-source-image','invoice-upload-','addMedia','Open Photos','photo picker','photo','keyboard','Not Now','Save Password','Email address','Authenticator or recovery code','driver','XCTest','startup','tab-forum','payment','description','timeout','permission','Unable to','NoSuchElement','scroll','UIContinuousPathIntroductionView','record-after-login','native server','Expo') if label.lower() in error_msg.lower()]
            print('NATIVE TEST',tag,n,len(tests),'failures',count('failure'),'errors',count('error'),'skips',count('skipped'),'landmarks',safe_markers)
            receipts['nativeSuites'].append({'landmarks':safe_markers,'suite':n,'group':tag,'tests':len(tests),'failures':count('failure'),'errors':count('error'),'skipped':count('skipped'),**source})
        caption=None
        if kind=='ios-history' and n in HISTORIC_IOS:
            caption=HISTORIC_IOS[n]
        elif kind=='onesa' and n in ('android-signed-out.png','ios-member-signed-out.png'):
            caption='Sign in with Onesa before credentials, '+('compact Android emulator' if n.startswith('android') else 'iPhone simulator')
        elif kind=='farm' and leaf=='signed-out-smart-farmer.png' and ('login/' in n or 'takeScreenshot/' in n):
            category='ipad' if n.startswith('ipad') else 'phone'
            if category not in emitted:
                caption='Signed-out '+('iPad' if category=='ipad' else 'phone')+' farm acceptance screen'
                emitted.add(category)
        if caption:
            filename=tag+'-'+n.replace('/','-').replace('^','').replace('$','')
            add_screen(z.read(n),filename,caption,source)

def capture_run(run, sha, groups):
    info=api('/actions/runs/'+str(run))
    assert info['head_sha']==sha, (run,info['head_sha'],sha)
    jobs=api('/actions/runs/'+str(run)+'/jobs?per_page=100')['jobs']
    receipts['jobs'] += [{'run':run,'head':sha,'name':j['name'],'url':j['html_url'],'status':j['status'],'conclusion':j['conclusion']} for j in jobs]
    arts=api('/actions/runs/'+str(run)+'/artifacts?per_page=100')['artifacts']
    for a in arts:
        key = str(a['id']) if str(a['id']) in groups else a['name']
        if key not in groups: continue
        tag,kind=groups[key]
        src=source_artifact(run,a)
        src['farmerCommit']=sha
        with tempfile.TemporaryFile() as f:
            subprocess.run(['gh','api','repos/'+REPO+'/actions/artifacts/'+str(a['id'])+'/zip'],stdout=f,check=True)
            f.seek(0)
            assert hashlib.file_digest(f,'sha256').hexdigest()==src['sha256']
            f.seek(0)
            with ZipFile(f) as z:
                harvest(z,src,tag,kind)
        receipts['archives'].append(src)

capture_run(43102900837,FARMER,{'13892053926':('web','web')})
capture_run(43102900932,FARMER,{'13891719398':('apple-archive','ios')})
capture_run(43102901057,FARMER,{'13892334857':('android-bundle','android')})
capture_run(43094817484,'08498917394bdd5d4b7938f2522635b4a8ee2c13',{'13891718330':('earlier-ios-farm','ios-history')})
capture_run(43100158237,'8e636df8e2a8ad2ee1093873bef567e881ab963c',{'13893273548':('earlier-android-farm','farm'),'13894371918':('earlier-ios-onesa','onesa')})
capture_run(43105366426,'8aab77cc585c9092ee4271e2cb4a01073b4dd762',{'native-ios-acceptance':('previous-paired-ios-farm','farm')})
for run,sha,prefix in [(43102901141,FARMER,'application'),(43106081557,QA,'paired')]:
    groups={}
    for plat in ('android','ios'):
        groups['native-onesa-'+plat]=(prefix+'-'+plat+'-onesa','onesa')
        groups['native-'+plat+'-acceptance']=(prefix+'-'+plat+'-farm','farm')
    capture_run(run,sha,groups)
assert (PACKAGES/BUNDLES['ios'][2]).is_file() and (PACKAGES/BUNDLES['android'][2]).is_file()
(REVIEW/'receipts'/'qualification.json').write_text(json.dumps(receipts,indent=2))
(REVIEW/'observations.json').write_text(json.dumps(report,indent=2))
(PACKAGES/'SHA256SUMS').write_text(''.join(v[1]+'  '+v[2]+'\n' for v in BUNDLES.values()))

def esc(value):
    return html.escape(str(value))
def table(columns,rows):
    return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+esc(c)+'</th>' for c in columns)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+esc(c)+'</td>' for c in row)+'</tr>' for row in rows)+'</tbody></table></div>'
def link(name,url):
    return '<a href="'+html.escape(url,quote=True)+'">'+esc(name)+'</a>'
def para(s):
    return '<p>'+esc(s).replace('\x60','')+'</p>'
snapshot = report['base']
head='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Farmer release verification</title><style>body{font:16px/1.55 system-ui;color:#23382c;background:#f7f8f1;margin:auto;max-width:1100px;padding:clamp(1rem,4vw,3rem)}a{color:#24583a}h1,h2{line-height:1.15}h2{margin-top:1.6em}p{max-width:75ch}.scroll{overflow-x:auto}table{border-collapse:collapse;background:white}td,th{text-align:left;vertical-align:top;padding:.55em;border-bottom:1px solid #d4dbca}section{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:16px}figure{background:white;margin:0;padding:14px}figure a{display:grid;height:240px;place-items:center}img{max-width:100%;max-height:240px}figcaption,small{display:block;margin-top:5px}li{margin:.35em 0}code{overflow-wrap:anywhere}</style>'
parts=[head,'<h1>Smart Farmer release verification</h1>',para('11 November 2026'),para(snapshot['intro']),'<h2>Release decisions</h2>',table(['Release','Decision','Remaining gate'],report['decisions']),'<h2>Source and builds</h2>']
for name,sha,url in snapshot['sources']:
    parts.append('<p>'+link(name,url)+' <code>'+esc(sha)+'</code></p>')
parts += [para('Both mobile products use eu.onesa.smartfarmer, version 0.2.0 build 1.'),para(snapshot['apple']),para(snapshot['google']),'<h2>Account and farm access</h2>',para(snapshot['identity']),para(snapshot['privacy']),'<h2>Customer journeys</h2>',para('Web results use the integrated source and a live database. The native farm suites use local Farmer accounts. The execution history below identifies the exact tested revision, job, platform and stage.'),table(['Journey','Web','Android','iPhone','iPad'],report['matrix']),'<ul>'+''.join('<li>'+esc(x)+'</li>' for x in snapshot['details'])+'</ul>','<h2>Design and languages</h2>',para(snapshot['design']),'<h2>Owners and next actions</h2>',table(['Owner','Next action'],snapshot['gates']),'<h2>Installed native tests</h2>']
parts += [table(['Run','Job','Outcome','Commit'],[(x['run'],x['name'],x['conclusion'] or x['status'],x['head'][:12]) for x in receipts['jobs'] if x['name'].startswith(('android (','ios ('))]),table(['Execution group','Native suite','Run','Passed','Failed or errored','Skipped'],[(x['group'],x['suite'],x['run'],x['tests']-x['failures']-x['errors']-x['skipped'],x['failures']+x['errors'],x['skipped']) for x in receipts['nativeSuites']])]
parts += ['<h2>Screen captures</h2><section>']
for f in figures:
    parts.append('<figure><a href="'+esc(f['file'])+'"><img src="'+esc(f['file'])+'" alt="'+esc(f['caption'])+'"></a><figcaption>'+esc(f['caption'])+'<small>'+esc(f['farmerCommit'][:12])+' · '+link('Original run artifact',f['url'])+'</small></figcaption></figure>')
parts+=['</section><h2>Full browser suite</h2><ul>'+''.join('<li>'+esc(x)+'</li>' for x in receipts['browserGroups'])+'</ul><h2>Review links</h2><ul>'+''.join('<li>'+link(n,url)+'</li>' for n,url in report['links'].items())+'</ul></html>']
(REVIEW/'index.html').write_text(''.join(parts))
print('Saved',len(figures),'screenshots,',len(receipts['nativeSuites']),'native JUnit suite records,',len(receipts['browserGroups']),'browser workflow groups and both verified packages.')

for f in figures:
    print('SCREEN',f['file'],f['sha256'])
for name in ('ios-results.txt','android-results.txt','ios-product-records.txt','android-product-records.txt','ios-intake-checks.txt','android-intake-checks.txt'):
    for result_file in sorted((REVIEW/'receipts').glob('*/'+name)):
        print('SUITE RECEIPT',result_file.parent.name,name)
        print(result_file.read_text()[:2400])
