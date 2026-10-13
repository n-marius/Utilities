import json, sys
def enc(coords):
    out=[]; px=py=0
    for x,y in coords:
        ix=round(x*1000); iy=round(y*1000)
        out += [ix-px, iy-py]; px,py=ix,iy
    return out
def rings(geom):
    t=geom['type']; c=geom['coordinates']
    if t=='Polygon': return [enc(r) for r in c]
    if t=='MultiPolygon': return [enc(r) for p in c for r in p]
    if t=='LineString': return [enc(c)]
    if t=='MultiLineString': return [enc(l) for l in c]
    return []
L=lambda f: json.load(open(f))['features']
out={}
out['countries']=[[f['properties'].get('NAME_DE') or f['properties'].get('NAME'), f['properties'].get('MIN_LABEL') or 5, round(f['properties']['LABEL_X'],2), round(f['properties']['LABEL_Y'],2), rings(f['geometry'])] for f in L('c.json') if f['geometry']]
out['admin1']=[[f['properties'].get('MIN_ZOOM') or 0, rings(f['geometry'])] for f in L('a1.json') if f['geometry']]
out['lakes']=[[f['properties'].get('name_de') or f['properties'].get('name') or '', f['properties'].get('min_zoom') or 0, rings(f['geometry'])] for f in L('l.json') if f['geometry']]
out['rivers']=[[f['properties'].get('name') or '', f['properties'].get('min_zoom') or 0, rings(f['geometry'])] for f in L('r.json') if f['geometry']]
out['places']=[[f['properties'].get('NAME_DE') or f['properties']['NAME'], f['properties'].get('MIN_ZOOM') or 0, round(f['geometry']['coordinates'][0]*1000), round(f['geometry']['coordinates'][1]*1000), f['properties'].get('POP_MAX') or 0, f['properties'].get('ADM0CAP') or 0] for f in json.load(open('pp.geojson'))['features']]
s=json.dumps(out, separators=(',',':'), ensure_ascii=False)
open(sys.argv[1],'w').write(s)
print(len(s), {k:len(v) for k,v in out.items()})
