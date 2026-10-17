// Boot prelude: the classes later batches need at evaluation time.
// 'extends' runs while a file is parsed — with scripts loading in parallel
// batches any file can be evaluated before its dependency finished loading,
// so these base classes are bundled here and always execute first.
class AbstractLoadedEntity {
    constructor(id, url, callback) {
        this._id             = id;
        this._url            = url;
        this._code           = null;
        this._loaded         = false;
        this._loadedCallback = callback;
    }

    getId() {
        return this._id;
    }

    /**
     * Registry name of the entity, set by the loader that registers it (an
     * entity loaded by URL alone keeps a null code).
     *
     * @param {string|null} code
     */
    setCode(code) {
        this._code = code;
        return this;
    }

    getCode() {
        return this._code;
    }

    getUrl() {
        return this._url;
    }

    isLoaded() {
        return this._loaded;
    }

    setLoaded() {
        this._loaded = true;
        this._loadedCallback();
    }

    finalizeInit() {
    }
}

class Object3d extends AbstractLoadedEntity {
    constructor(id, url, callback) {
        super(id, url, callback);

        this.ptOrigin      = [];
        this.pt3d          = [];
        this.pt2d          = [];
        this.ptCount       = 0;
        this.faceList      = [];
        this.faceCount     = 0;
        this._textureIds   = [];
        // Face indices per render pass, filled by finalizeInit: blended faces
        // are drawn after the opaque ones.
        this.opaqueFaces        = [];
        this.alphaFaces         = [];
        this._translucent       = false;
        this._groupLightFactors = {};
        this._faceGroupsVersion = 0;
        this._renderTint        = null;
    }

    // Faces changed texture: renderers rebuild their cached draw-state batches
    invalidateFaceGroups() {
        this._faceGroupsVersion++;
    }

    getFaceGroupsVersion() {
        return this._faceGroupsVersion;
    }

    // A face below full alpha or additive blends over what lies behind it;
    // a texture with transparent texels alone does not.
    isTranslucent() {
        return this._translucent;
    }

    // Light factor of the faces sharing a lightGroup; 1 = baked colour untouched
    setGroupLightFactor(group, factor) {
        this._groupLightFactors[group] = factor;
    }

    // Flat replacement colour [r, g, b] for the whole object, consumed by the
    // renderers that draw no texture; null leaves them on the face colours.
    setRenderTint(color) {
        this._renderTint = color;
        return this;
    }

    getRenderTint() {
        return this._renderTint;
    }

    getFaceLightFactor(fc) {
        if (fc.lightGroup === null) {
            return 1;
        }
        const factor = this._groupLightFactors[fc.lightGroup];
        return ((factor === undefined) ? 1 : factor);
    }

    ptAdd(x, y, z) {
        x = parseFloat(x); y = parseFloat(y); z = parseFloat(z);
        this.ptOrigin.push([x, y, z, 1]);
        this.pt3d.push([x, y, z, 1]);
        this.pt2d.push([0, 0, 0]);
        this.ptCount++;
        return this;
    }

    textureAdd(url) {
        this._textureIds.push(loader.textures().load(url));
        return this;
    }

    textureAddById(textureId) {
        this._textureIds.push(textureId);
        return this;
    }

    fcAdd(pt1, pt2, pt3, color, texture, map, clampV = false, passableUser = false, passableEnemy = false, animTextures = null, uvScroll = null, lightGroup = null, uvAnchor = null) {
        if (!color) {
            color = [255., 255., 255.];
        }
        if (!texture && animTextures) {
            texture = animTextures.ids[0];
        }
        if (!texture) {
            texture = null;
        }
        if (!map) {
            map = null;
        }
        if (texture > this._textureIds.length) {
            texture = null;
        }
        if (texture === null) {
            map = null;
        }
        if (map === null) {
            map = [[0, 0], [1, 0], [1, 1]];
        }

        let alpha;
        if (color[3]) {
            alpha    = parseFloat(color[3]);
            color[3] = null;
        } else {
            alpha = 1.;
        }

        color[0] = parseFloat(color[0]); color[1] = parseFloat(color[1]); color[2] = parseFloat(color[2]);

        map[0][0] = parseFloat(map[0][0]); map[0][1] = 1. - parseFloat(map[0][1]);
        map[1][0] = parseFloat(map[1][0]); map[1][1] = 1. - parseFloat(map[1][1]);
        map[2][0] = parseFloat(map[2][0]); map[2][1] = 1. - parseFloat(map[2][1]);

        if (texture) {
            color[0] = parseFloat(color[0]) / 255.;
            color[1] = parseFloat(color[1]) / 255.;
            color[2] = parseFloat(color[2]) / 255.;
        } else {
            color[0] = parseFloat(color[0]);
            color[1] = parseFloat(color[1]);
            color[2] = parseFloat(color[2]);
        }

        if (this.ptOrigin[pt1-1] === undefined) {
            throw new Error('pt1 ' + pt1 + ' undefined');
        }
        if (this.ptOrigin[pt2-1] === undefined) {
            throw new Error('pt2 ' + pt2 + ' undefined');
        }
        if (this.ptOrigin[pt3-1] === undefined) {
            throw new Error('pt3 ' + pt3 + ' undefined');
        }

        const anim = ((animTextures) ? {ids: animTextures.ids.map((id) => this._textureIds[id - 1]), duration: animTextures.duration, durationMs: Math.round(animTextures.duration * 1000)} : null);
        const scroll = ((uvScroll) ? {u: parseFloat(uvScroll.u ?? 0), v: parseFloat(uvScroll.v ?? 0)} : null);
        const anchor = ((uvAnchor) ? {code: uvAnchor.code, v: parseFloat(uvAnchor.v), instance: null} : null);
        this.faceList.push(new Face(pt1-1, pt2-1, pt3-1, color, ((texture) ? this._textureIds[texture - 1] : null), map, alpha, clampV, passableUser, passableEnemy, anim, scroll, lightGroup, anchor));
        this.faceCount++;
        return this;
    }

    getFaceCount() {
        return this.faceCount;
    }

    getVertexCount() {
        return this.ptCount;
    }

    finalizeInit() {
        const n = this.ptCount;
        if (n > 0) {
            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < n; i++) {
                cx += this.ptOrigin[i][0];
                cy += this.ptOrigin[i][1];
                cz += this.ptOrigin[i][2];
            }
            cx /= n; cy /= n; cz /= n;
            this._center = [cx, cy, cz];
            let r = 0;
            for (let i = 0; i < n; i++) {
                const d = (this.ptOrigin[i][0]-cx)**2 + (this.ptOrigin[i][1]-cy)**2 + (this.ptOrigin[i][2]-cz)**2;
                if (d > r) {
                    r = d;
                }
            }
            this._boundingRadius = Math.sqrt(r);
        } else {
            this._center = [0, 0, 0];
            this._boundingRadius = 0;
        }

        this._localNormals = new Float32Array(this.faceCount * 3);
        for (let k = 0; k < this.faceCount; k++) {
            const fc = this.faceList[k];
            const A = this.ptOrigin[fc.pts[0]], B = this.ptOrigin[fc.pts[1]], C = this.ptOrigin[fc.pts[2]];
            const abx = B[0]-A[0], aby = B[1]-A[1], abz = B[2]-A[2];
            const acx = C[0]-A[0], acy = C[1]-A[1], acz = C[2]-A[2];
            let nx = aby*acz - abz*acy;
            let ny = abz*acx - abx*acz;
            let nz = abx*acy - aby*acx;
            const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
            if (len > 1e-10) {
                nx /= len;
                ny /= len;
                nz /= len;
            }
            this._localNormals[k*3]   = nx;
            this._localNormals[k*3+1] = ny;
            this._localNormals[k*3+2] = nz;
        }

        this.opaqueFaces  = [];
        this.alphaFaces   = [];
        this._translucent = false;
        for (let k = 0; k < this.faceCount; k++) {
            const fc = this.faceList[k];
            if (fc.collisionOnly === true) {
                continue;
            }
            const translucent = ((fc.alpha < 1) || (fc.blendAdd === true));
            fc.isAlpha = (translucent || ((fc.textureId !== null) && loader.textures().get(fc.textureId).isAlpha()));
            ((fc.isAlpha) ? this.alphaFaces : this.opaqueFaces).push(k);
            this._translucent = (this._translucent || translucent);
        }
    }

    getTextureId(index) {
        return this._textureIds[index - 1];
    }

    getCenter() {
        return this._center;
    }

    getBoundingRadius() {
        return this._boundingRadius;
    }

    ptTransform(m) {
        for (let x = 0; x < this.ptCount; x++) {
            this.pt3d[x][0] = m.v[0][0]*this.ptOrigin[x][0] + m.v[1][0]*this.ptOrigin[x][1] + m.v[2][0]*this.ptOrigin[x][2] + m.v[3][0]*this.ptOrigin[x][3];
            this.pt3d[x][1] = m.v[0][1]*this.ptOrigin[x][0] + m.v[1][1]*this.ptOrigin[x][1] + m.v[2][1]*this.ptOrigin[x][2] + m.v[3][1]*this.ptOrigin[x][3];
            this.pt3d[x][2] = m.v[0][2]*this.ptOrigin[x][0] + m.v[1][2]*this.ptOrigin[x][1] + m.v[2][2]*this.ptOrigin[x][2] + m.v[3][2]*this.ptOrigin[x][3];
            this.pt3d[x][3] = m.v[0][3]*this.ptOrigin[x][0] + m.v[1][3]*this.ptOrigin[x][1] + m.v[2][3]*this.ptOrigin[x][2] + m.v[3][3]*this.ptOrigin[x][3];
        }
        const m00=m.v[0][0], m10=m.v[1][0], m20=m.v[2][0];
        const m01=m.v[0][1], m11=m.v[1][1], m21=m.v[2][1];
        const m02=m.v[0][2], m12=m.v[1][2], m22=m.v[2][2];
        for (let k = 0; k < this.faceCount; k++) {
            const i = k * 3;
            const nx = this._localNormals[i], ny = this._localNormals[i+1], nz = this._localNormals[i+2];
            const n = this.faceList[k].normal;
            n[0] = m00*nx + m10*ny + m20*nz;
            n[1] = m01*nx + m11*ny + m21*nz;
            n[2] = m02*nx + m12*ny + m22*nz;
        }
        return this;
    }

    ptProjection(engine) {
        for (let k = 0; k < this.ptCount; k++) {
            const p = this.pt2d[k];
            // The flat/fast renderers do not near-clip, so z can be <= 0 here
            const z = Math.max(this.pt3d[k][2], Object3d.PROJECTION_MIN_Z);
            p[0] = Math.trunc(engine.projScaleX * this.pt3d[k][0] / z - engine.projOffsetX);
            p[1] = Math.trunc(-engine.projScaleY * this.pt3d[k][1] / z - engine.projOffsetY);
            p[2] = this.pt3d[k][2];
        }
        return this;
    }
}
if (typeof Object3d.PROJECTION_MIN_Z === 'undefined') { Object3d.PROJECTION_MIN_Z = 1e-5; }

class Object3dRendererBase {
    constructor() {
        this._litColor          = [0, 0, 0];
        this._lightContribution = [0, 0, 0];
        this._uvOffsetOut       = [0, 0];
        this._spriteCanvases    = new WeakMap();
        this._queue             = new FaceDepthQueue();
        this._styles            = [];
        this._styleIndex        = new Map();
    }

    isAvailable() {
        return true;
    }

    // Whether the renderer reads Object3d.pt2d: flat and fast do, webgl and
    // full project on their own and the engine skips that pass for them.
    needsProjection() {
        return true;
    }

    initCanvas(canvas) {
        return canvas.getContext('2d');
    }

    // flat and fast keep this fixed backdrop and get no sky, by design; full and
    // webgl override it with their own scene background.
    begin(engine) {
        engine.scrCtx.fillStyle = Object3dRendererBase.BACKDROP_COLOR;
        engine.scrCtx.fillRect(0, 0, engine.scrWidth, engine.scrHeight);
        this._queue.clear();
        this._styles.length = 0;
        this._styleIndex.clear();
    }

    // The frame is drawn here, farthest triangle first, whatever object each
    // came from. The canvas state is only touched when the style changes, and
    // the sorted queue keeps those runs long. A no-op for webgl, which
    // overrides draw and queues nothing.
    end(engine) {
        this._flushQueue(engine);
    }

    // flat and fast have no depth buffer: the queue is painted now, so what comes next paints over it.
    clearDepth(engine) {
        this._flushQueue(engine);
    }

    _flushQueue(engine) {
        const ctx      = engine.scrCtx;
        const geometry = this._queue.getGeometry();
        const styles   = this._queue.getStyles();
        const order    = this._queue.sorted();
        let current    = -1;
        for (let i = 0; i < order.length; i++) {
            const t = order[i];
            if (styles[t] !== current) {
                current = styles[t];
                ctx.fillStyle   = this._styles[current][0];
                ctx.strokeStyle = this._styles[current][1];
            }
            const o = t * FaceDepthQueue.STRIDE;
            ctx.beginPath();
            ctx.moveTo(geometry[o], geometry[o + 1]);
            ctx.lineTo(geometry[o + 2], geometry[o + 3]);
            ctx.lineTo(geometry[o + 4], geometry[o + 5]);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
        this._queue.clear();
    }

    // Style slot of the frame, -1 when that key has not been registered yet:
    // the renderers build their colour strings only on a miss.
    _styleSlot(key) {
        const id = this._styleIndex.get(key);

        return ((id === undefined) ? -1 : id);
    }

    _addStyle(key, fill, stroke) {
        const id = this._styles.length;
        this._styles.push([fill, stroke]);
        this._styleIndex.set(key, id);

        return id;
    }

    // Queue one face, for the renderers whose style costs nothing to resolve.
    // The others clip first (_faceScreenTriangles) and only pay for the faces
    // that survive.
    _pushFace(engine, obj, fc, styleId) {
        this._pushTriangles(obj, fc, this._faceScreenTriangles(engine, obj, fc), styleId);
    }

    // Screen triangles of a face, keyed by the depth of its FARTHEST vertex: a
    // huge floor triangle then sinks to the back of the queue, behind the
    // bodies standing on it. tris = null means the face is wholly in front.
    _pushTriangles(obj, fc, tris, styleId) {
        if (tris === null) {
            const p0 = obj.pt2d[fc.pts[0]];
            const p1 = obj.pt2d[fc.pts[1]];
            const p2 = obj.pt2d[fc.pts[2]];
            const depth = Math.max(obj.pt3d[fc.pts[0]][2], obj.pt3d[fc.pts[1]][2], obj.pt3d[fc.pts[2]][2]);
            this._queue.push(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], depth, styleId);
            return;
        }
        for (let t = 0; t < tris.length; t++) {
            const tri = tris[t];
            this._queue.push(
                tri[0][0], tri[0][1], tri[1][0], tri[1][1], tri[2][0], tri[2][1],
                Math.max(tri[0][2], tri[1][2], tri[2][2]), styleId
            );
        }
    }

    // Draw a textured quad in normalised screen space (x, y top-left, w, h in
    // 0..1; y downward), over the scene without depth, tinted by light (0..1)
    // and faded by alpha (0..1, 1 = opaque). Shared by the canvas-2D
    // renderers; the WebGL one overrides it with its own program.
    drawScreenSprite(engine, texId, x, y, w, h, light, alpha = 1) {
        const ctx = engine.scrCtx;
        const tex = ((texId !== null) ? loader.textures().get(texId) : null);
        if (!ctx || !tex) {
            return;
        }
        // A scene-wide light floor or flash boost must reach the sprite too.
        let lit = Math.max(light, (engine.lightOverride ?? 0));
        if (lit < 1) {
            lit = Math.min(1, lit + engine.lightBoost);
        }
        ctx.save();
        // Never filtered: these renderers sample their texels nearest-neighbour.
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha           = alpha;
        ctx.filter                = 'brightness(' + lit + ')';
        ctx.drawImage(
            this._spriteCanvas(tex),
            x * engine.scrWidth,
            y * engine.scrHeight,
            w * engine.scrWidth,
            h * engine.scrHeight
        );
        ctx.restore();
    }

    // drawImage needs a canvas, never the ImageData the loader holds. Straight
    // alpha, unlike the WebGL upload: the browser composites it.
    _spriteCanvas(tex) {
        if (this._spriteCanvases.has(tex)) {
            return this._spriteCanvases.get(tex);
        }
        const canvas  = document.createElement('canvas');
        canvas.width  = tex.width;
        canvas.height = tex.height;
        canvas.getContext('2d').putImageData(new ImageData(tex.data, tex.width, tex.height), 0, 0);
        this._spriteCanvases.set(tex, canvas);

        return canvas;
    }

    // Where the segment va→vb crosses the near plane, as {t, cx, cy, sx, sy}:
    // index-free, so every vertex layout can use it.
    _nearCrossing(engine, za, cxa, cya, zb, cxb, cyb) {
        const zNear = engine.zBuffer.getNear();
        const t     = (zNear - za) / (zb - za);
        const cx    = cxa + t * (cxb - cxa);
        const cy    = cya + t * (cyb - cya);

        return {
            t,
            cx,
            cy,
            sx: Math.trunc(engine.projScaleX * cx / zNear - engine.projOffsetX),
            sy: Math.trunc(-engine.projScaleY * cy / zNear - engine.projOffsetY)
        };
    }

    // Position-only layout [sx, sy, cz, cx, cy], enough for the renderers that
    // interpolate nothing else. Overridden by those carrying more channels.
    _clipVertex(engine, va, vb) {
        const c = this._nearCrossing(engine, va[2], va[3], va[4], vb[2], vb[3], vb[4]);

        return [c.sx, c.sy, engine.zBuffer.getNear(), c.cx, c.cy];
    }

    // Sutherland-Hodgman near clip of one triangle, into 0, 1 or 2 triangles:
    // layout-agnostic, the depth sits at index 2 and _clipVertex packs the
    // vertices it creates.
    _clipNear(engine, v0, v1, v2) {
        const zNear       = engine.zBuffer.getNear();
        const verts       = [v0, v1, v2];
        const inside      = [(v0[2] >= zNear), (v1[2] >= zNear), (v2[2] >= zNear)];
        const insideCount = inside.filter(Boolean).length;

        if (insideCount === 3) {
            return [[v0, v1, v2]];
        }
        if (insideCount === 0) {
            return [];
        }

        if (insideCount === 1) {
            const i = inside.indexOf(true);
            const j = (i + 1) % 3;
            const k = (i + 2) % 3;
            return [[
                verts[i],
                this._clipVertex(engine, verts[i], verts[j]),
                this._clipVertex(engine, verts[i], verts[k]),
            ]];
        }

        // Two vertices inside: the clipped quad splits into two triangles.
        const iOut = inside.indexOf(false);
        const iIn1 = (iOut + 1) % 3;
        const iIn2 = (iOut + 2) % 3;
        const a = this._clipVertex(engine, verts[iOut], verts[iIn1]);
        const b = this._clipVertex(engine, verts[iOut], verts[iIn2]);
        return [
            [verts[iIn1], verts[iIn2], a],
            [verts[iIn2], b, a],
        ];
    }

    // Face corner in the position-only layout above.
    _positionVertex(obj, fc, idx) {
        const pt3d = obj.pt3d[fc.pts[idx]];
        const pt2d = obj.pt2d[fc.pts[idx]];

        return [pt2d[0], pt2d[1], pt3d[2], pt3d[0], pt3d[1]];
    }

    // Near-clipped triangles of a face, null when the whole face is in front —
    // the common case, drawn straight from pt2d with nothing allocated — and
    // empty when it is entirely behind.
    _faceScreenTriangles(engine, obj, fc) {
        const zNear = engine.zBuffer.getNear();
        if ((obj.pt3d[fc.pts[0]][2] >= zNear)
            && (obj.pt3d[fc.pts[1]][2] >= zNear)
            && (obj.pt3d[fc.pts[2]][2] >= zNear)) {
            return null;
        }

        return this._clipNear(
            engine,
            this._positionVertex(obj, fc, 0),
            this._positionVertex(obj, fc, 1),
            this._positionVertex(obj, fc, 2)
        );
    }

    // Light level 0..1 of a face for the depth curve, before the ambient of
    // _pointColor. Untextured face colours are 0..255.
    static faceLight(fc, lightFactor, textured) {
        const colorMax = Math.max(fc.color[0], Math.max(fc.color[1], fc.color[2]));

        return Math.min(1, ((textured) ? colorMax : colorMax / 255) * lightFactor);
    }

    // The depth curve of the frame, null when off: an active light override
    // bypasses it, a fullbright scene has no distance attenuation.
    static frameShading(engine) {
        return (((engine.depthShading !== null) && ((engine.lightOverride ?? 0) <= 0)) ? engine.depthShading : null);
    }

    // Camera space puts the eye at the origin, so normal·vertex >= 0 means the
    // face turns away from it.
    _isBackFace(normal, pt) {
        return ((normal[0] * pt[0] + normal[1] * pt[1] + normal[2] * pt[2]) >= 0);
    }

    _resolveTexId(fc, sceneMs) {
        if (fc.animTextures === null) {
            return fc.textureId;
        }
        const frameIdx = Math.floor(sceneMs / fc.animTextures.durationMs) % fc.animTextures.ids.length;
        return fc.animTextures.ids[frameIdx];
    }

    // Per-frame UV offset of a face: the time scroll (wrapped to [0,1) so the
    // texture-repeat wrap downstream keeps full float precision) plus the
    // anchor following a named instance's vertical shift. Shared array.
    _uvOffset(fc, sceneMs) {
        const off = this._uvOffsetOut;
        off[0] = 0;
        off[1] = 0;
        if (fc.uvScroll) {
            const t = sceneMs / 1000;
            off[0] = (t * fc.uvScroll.u) % 1;
            off[1] = (t * fc.uvScroll.v) % 1;
        }
        if (fc.uvAnchor !== null) {
            const anchor = fc.uvAnchor;
            if (anchor.instance === null) {
                const id = loader.instances().idByCode(anchor.code);
                anchor.instance = ((id !== null) ? loader.instances().get(id) : null);
            }
            if (anchor.instance !== null) {
                off[1] += anchor.instance.getVerticalShift() * anchor.v;
            }
        }
        return off;
    }

    _pointColor(engine, color, pt, normal) {
        const col = this._litColor;
        col[0] = engine.ambientLight[0];
        col[1] = engine.ambientLight[1];
        col[2] = engine.ambientLight[2];

        const contribution = this._lightContribution;
        for (let k = 0; k < engine.lightList.length; k++) {
            engine.lightList[k].getColorFor(pt, normal, contribution);
            col[0] += contribution[0];
            col[1] += contribution[1];
            col[2] += contribution[2];
        }

        if (col[0] < 0.) {
            col[0] = 0.;
        }
        if (col[0] > 255.) {
            col[0] = 255.;
        }
        if (col[1] < 0.) {
            col[1] = 0.;
        }
        if (col[1] > 255.) {
            col[1] = 255.;
        }
        if (col[2] < 0.) {
            col[2] = 0.;
        }
        if (col[2] > 255.) {
            col[2] = 255.;
        }

        col[0] = color[0] * col[0] / 255.;
        col[1] = color[1] * col[1] / 255.;
        col[2] = color[2] * col[2] / 255.;

        return col;
    }
}
if (typeof Object3dRendererBase.BACKDROP_COLOR === 'undefined') { Object3dRendererBase.BACKDROP_COLOR = '#666666'; }

class AbstractGameProfile {
    /**
     * Identifier of the game this profile implements.
     *
     * @returns {string} e.g. 'default', 'doom', 'heretic'
     */
    getCode() {
        this._generateException('getCode must be implemented');
        return '';
    }

    /**
     * True when the WAD content identifies this profile's game. The fallback
     * profile (default) is never probed — it answers for any unmatched WAD.
     *
     * @param {WadFile} wadFile
     * @returns {boolean}
     */
    matchesWad(wadFile) {
        return false;
    }

    /**
     * Linedef special remaps (WAD number → internal WadConstants code).
     * Only the divergent ones; every absent special is identity, 0 = dropped.
     *
     * @returns {object}
     */
    linedefSpecialMap() {
        return {};
    }

    /**
     * Sector special remaps (WAD number → internal WadConstants code).
     * Identity when absent, 0 = dropped.
     *
     * @returns {object}
     */
    sectorSpecialMap() {
        return {};
    }

    /**
     * Game-specific entries merged into the WadConstants baseline tables
     * before each level build (WadConstants.applyGameExtensions). Every entry
     * lives in the >= 1000 namespace and is only reachable through this
     * profile's own special maps. Table name → entries (object or array for
     * a Set). The baseline needs none.
     *
     * @returns {object}
     */
    wadConstantsExtensions() {
        return {};
    }

    /**
     * Level progression data (WadMapInfo synthesizes the per-level chain from
     * these rules applied to the level code patterns; UMAPINFO overlays it).
     *
     * @returns {{episodeSecretReturns: object, mapSecretSlot: string, mapSuperSecretSlot: string, mapSecretReturn: string}}
     */
    progressionRules() {
        this._generateException('progressionRules must be implemented');
        return {};
    }

    /**
     * Display names of the game's episodes, keyed by the episode's first map
     * slot (uppercase). The names are proper nouns, never translated — like
     * the level names. An episode present in the WAD but absent from this
     * table only shows its number ("Episode 6").
     *
     * @returns {object} first level code → episode name
     */
    episodeNames() {
        this._generateException('episodeNames must be implemented');
        return {};
    }

    /**
     * Readable level names keyed by level code (uppercase), the game's own
     * HUSTR strings without their "E1M1: " prefix. Proper nouns, never
     * translated. Consulted after the WAD's UMAPINFO and DEHACKED; a level
     * absent from the table simply shows its code.
     *
     * @returns {object} level code → level name
     */
    levelNames() {
        this._generateException('levelNames must be implemented');
        return {};
    }

    /**
     * Prefix of the game's level-name strings in a DEHACKED [STRINGS] section
     * (d_englsh.h: HUSTR_ for Doom and Doom II, THUSTR_ / PHUSTR_ for TNT and
     * Plutonia), the codes a WAD redefines to rename its levels.
     *
     * @returns {string}
     */
    levelNameStringPrefix() {
        this._generateException('levelNameStringPrefix must be implemented');
        return '';
    }

    /**
     * RGB tint of the BFG lightning decal (the WAD art shades differ).
     *
     * @returns {number[]}
     */
    bfgDecalShade() {
        this._generateException('bfgDecalShade must be implemented');
        return [];
    }

    /**
     * Catalog mapping the THING editor numbers of this game to world
     * descriptors; only the data (thingDecorations / thingTypes) is per-game.
     *
     * @returns {DoomThingCatalog}
     */
    createThingCatalog() {
        return new DoomThingCatalog(this.thingDecorations(), this.thingTypes());
    }

    /**
     * The game's monster catalog; only the data (monsterDefs) is per-game.
     *
     * @returns {DoomMonsterCatalog}
     */
    createMonsterCatalog() {
        return new DoomMonsterCatalog(this.monsterDefs());
    }

    /**
     * Monster definitions of this game, transcribed from the UZDoom zscript
     * actors (stats, state machine, flags, drops).
     *
     * @returns {object} editor number → DoomMonsterDef
     */
    monsterDefs() {
        this._generateException('monsterDefs must be implemented');
        return {};
    }

    /**
     * Map actions fired when the last boss of a type dies (vanilla
     * A_BossDeath). Keyed by the same codes the monster defs carry in their
     * bossMaps ('E1M8', or 'MAP07-1'/'MAP07-2' when one map hosts two boss
     * groups — the level code is key.split('-')[0]). Value: {special, tag}
     * (internal special codes, same vocabulary as the mover tables) or
     * {exit: true}.
     *
     * @returns {object} boss-map code → action
     */
    bossActions() {
        return {};
    }

    /**
     * Maps where a teleporting MONSTER stomps whoever holds its arrival spot
     * instead of staying put (mapinfo `allowmonstertelefrags`): the Icon of
     * Sin's arena needs it, nothing else does.
     *
     * @returns {string[]} level codes
     */
    monsterTelefragMaps() {
        return [];
    }

    /**
     * Monster types this game spawns at RUNTIME rather than from the map
     * (the pain elemental's lost souls): their views have to be built with the
     * level, since a body born mid-fight has no chance to load a sprite.
     *
     * @returns {string[]} monster def codes
     */
    runtimeSpawnTypes() {
        return [];
    }

    /**
     * Editor numbers of the cooperative player starts, in slot order.
     *
     * @returns {int[]} index 0 = slot 1
     */
    playerStartTypes() {
        this._generateException('playerStartTypes must be implemented');
        return [];
    }

    /**
     * @returns {int} editor number of the deathmatch starts
     */
    deathmatchStartType() {
        this._generateException('deathmatchStartType must be implemented');
        return 0;
    }

    /**
     * The visible body of a player seen by the others, as a monster definition
     * (sprite and states) whose actions never run. Built on first use: the
     * monster classes load after the profiles.
     *
     * @returns {DoomMonsterDef}
     */
    playerBodyDef() {
        const data = this.playerBodyData();
        if (!AbstractGameProfile._playerBodies.has(data)) {
            AbstractGameProfile._playerBodies.set(data, new DoomMonsterDef(data));
        }

        return AbstractGameProfile._playerBodies.get(data);
    }

    /**
     * @returns {object} the DoomMonsterDef data of the player's body
     */
    playerBodyData() {
        this._generateException('playerBodyData must be implemented');
        return null;
    }

    /**
     * The player colour translations (zscript Player.ColorRange / Colorset): the
     * palette range a player sprite is drawn in, and per slot the first index
     * it is moved to plus the index standing for the colour (map arrow, lobby).
     *
     * @returns {{range: int[], slots: {from: int, marker: int}[]}} slots index 0 = slot 1
     */
    playerColors() {
        this._generateException('playerColors must be implemented');
        return null;
    }

    /**
     * What stays on the ground once picked up in a multiplayer game, and the
     * clips a weapon left there gives in deathmatch (null: its usual ammo).
     *
     * @returns {{weaponsStay: boolean, keysStay: boolean, deathmatchWeaponClips: int|null}}
     */
    multiplayerItemRules() {
        this._generateException('multiplayerItemRules must be implemented');
        return null;
    }

    /**
     * How a map item taken comes back when the items respawn (deathmatch):
     * after delayTics its effect and sound play on its spot, and it is back
     * revealTics later; the thing types listed never come back.
     *
     * @returns {{delayTics: int, revealTics: int, effect: string, sound: string, neverTypes: int[]}}
     */
    itemRespawnRules() {
        this._generateException('itemRespawnRules must be implemented');
        return null;
    }

    // One player per cooperative start (vanilla MAXPLAYERS matches the start count).
    maxPlayers() {
        return this.playerStartTypes().length;
    }

    /**
     * Per-game numbers of the shootable-body damage pipeline (gib threshold,
     * default kickback, blood behaviour) — UZDoom gameinfo + P_SpawnBlood.
     *
     * @returns {object} {gibFactor, defKickback, bloodTemplate, bloodDamageAdvance}
     */
    monsterDamageRules() {
        this._generateException('monsterDamageRules must be implemented');
        return {};
    }

    /**
     * Sprite lump a corpse ground by a mover turns into (the vanilla S_GIBS
     * pool, UZDoom Actor::Grind → GenericCrush). null = this game has none
     * and a crushed corpse keeps its own sprite.
     *
     * @returns {string|null}
     */
    crushedCorpseSprite() {
        return null;
    }

    /**
     * Pickup templates of the monsters' DropItems: zscript item name →
     * {sprite, effect} (fixed effect) or {sprite, ammoType} (the amount comes
     * from each monster's dropItems entry).
     *
     * @returns {object} name → {sprite, effect?|ammoType?}
     */
    dropItemTypes() {
        this._generateException('dropItemTypes must be implemented');
        return {};
    }

    /**
     * @returns {object} code → DoomDecoration
     */
    thingDecorations() {
        this._generateException('thingDecorations must be implemented');
        return {};
    }

    /**
     * THING editor-number table of this game.
     *
     * @returns {object} editor number → {kind, sprite|code, frames?, animDuration?, solid?, effect?}
     */
    thingTypes() {
        this._generateException('thingTypes must be implemented');
        return {};
    }

    /**
     * THING editor numbers that count towards the level's item score (vanilla
     * MF_COUNTITEM): bonuses and power-ups only. The pickup path relies on
     * these also being ALWAYSPICKUP in vanilla: counted even when useless.
     *
     * @returns {Set<number>}
     */
    countedItemTypes() {
        return new Set();
    }

    /**
     * Per-skill gameplay rules, transcribed from the game's UZDoom MAPINFO
     * skill blocks. Skill 0 is our own "Pacifist monsters" mode: the skill-3
     * world (spawn filter, ammo, damage) with monsters that never attack.
     *
     * @returns {object} skill (0-5) → {spawnFilterBit, ammoFactor, damageFactor,
     *                   monstersPacifist, fastMonsters, instantReaction,
     *                   respawnTicsDelay, easyBossBrain}
     */
    skillRules() {
        this._generateException('skillRules must be implemented');
        return {};
    }

    /**
     * gameinfo nightmarefast: under the fastMonsters skill, EVERY monster's
     * chase cadence halves at runtime (Heretic true; Doom relies on its Fast
     * states only — demon/spectre).
     *
     * @returns {boolean}
     */
    nightmareFast() {
        return false;
    }

    /**
     * @returns {object} code → DoomAmmo definition
     */
    buildAmmoTypes() {
        this._generateException('buildAmmoTypes must be implemented');
        return {};
    }

    /**
     * @returns {object} code → DoomWeapon definition
     */
    buildWeapons() {
        this._generateException('buildWeapons must be implemented');
        return {};
    }

    /**
     * @returns {object} code → DoomItem definition (keys, power-ups)
     */
    buildItems() {
        this._generateException('buildItems must be implemented');
        return {};
    }

    /**
     * Starting player loadout of a fresh game.
     *
     * @returns {{weapons: string[], activeWeapon: string|null, ammo: object, maxArmor: number}}
     */
    startingLoadout() {
        this._generateException('startingLoadout must be implemented');
        return {};
    }

    /**
     * ARMS panel layout: number of slots, weapon → slot mapping, the
     * always-lit slot and its upgrade weapon (accent border when owned).
     *
     * @returns {{count: number, byWeapon: object, alwaysOwnedSlot: number, upgradeWeapon: string}}
     */
    hudWeaponSlots() {
        this._generateException('hudWeaponSlots must be implemented');
        return {};
    }

    /**
     * Key item code → HUD dot color.
     *
     * @returns {object}
     */
    hudKeyColors() {
        this._generateException('hudKeyColors must be implemented');
        return {};
    }

    /**
     * Automap palette of this game, one entry per colour role of the drawing
     * ladder (see DoomAutomap.roleOf) plus the panel background. Picked by
     * GAME like the engine's own colorsets (am_map.cpp), never carried by the
     * WAD; a profile may depart from them, since our panel is translucent
     * where the engine draws on an opaque ground.
     *
     * @returns {object} role → [r, g, b]
     */
    automapColors() {
        this._generateException('automapColors must be implemented');
        return {};
    }

    /**
     * SNDINFO table of the game: logical sound name → {lump | alias | random}
     * plus the per-sound attributes ({limit, limitRange, pitch, singular}).
     * Lump NAMING is game data (Doom prefixes DS, Heretic uses bare names) —
     * sounds always resolve by name from this table, never by header sniffing.
     *
     * @returns {object} name → definition (see DoomSoundCatalog)
     */
    soundDefs() {
        this._generateException('soundDefs must be implemented');
        return {};
    }

    /**
     * Distance attenuation curve of the game ($rolloff of its SNDINFO):
     * {type: 'doom', min, max} for the log-scaled linear curve, or
     * {type: 'sndcurve', min, max} for a lookup in the WAD's SNDCURVE lump
     * (whose size overrides max when present).
     *
     * @returns {{type: string, min: number, max: number}}
     */
    soundRolloff() {
        this._generateException('soundRolloff must be implemented');
        return {type: 'doom', min: 0, max: 0};
    }

    /**
     * $pitchshiftrange of the game: the width (bits) of the random pitch
     * variation every sound start takes, unless its own def overrides it
     * (pitch 0 = fixed).
     *
     * @returns {number}
     */
    soundPitchRange() {
        this._generateException('soundPitchRange must be implemented');
        return 0;
    }

    /**
     * What each monster def voices (zscript sound properties), by def code:
     * {see, active, pain, death, melee, attack, boss?, actions?}.
     *
     * @returns {object}
     */
    monsterSounds() {
        this._generateException('monsterSounds must be implemented');
        return {};
    }

    /**
     * Door movement sound style (sndseq.txt): Doom starts its close leg on the
     * close lump and ends silently; Raven overrides with {closeStart: 'open',
     * closeArrival: true} (HereticDoorClose).
     *
     * @returns {{closeStart: string, closeArrival: boolean}}
     */
    doorSoundStyle() {
        return {closeStart: 'close', closeArrival: false};
    }

    /**
     * Ambient sound things (ednum → {loop} or {random}): none by default —
     * a Raven concept (waterfall/wind loops, HereticAmbience scripts).
     *
     * @returns {object}
     */
    ambientSounds() {
        return {};
    }

    /**
     * The game's sound sequences (SNDSEQ text format), used when the WAD
     * carries no SNDSEQ lump of its own: none by default — a Raven concept
     * (Heretic's ambient scripts, every Hexen mover).
     *
     * @returns {string}
     */
    soundSequencesText() {
        return '';
    }

    /**
     * Candidate lumps of the menu (title) music, first present in the WAD wins.
     *
     * @returns {string[]}
     */
    menuMusicLumps() {
        this._generateException('menuMusicLumps must be implemented');
        return [];
    }

    /**
     * Candidate lumps of the intermission music (the tally screen).
     *
     * @returns {string[]}
     */
    intermissionMusicLumps() {
        this._generateException('intermissionMusicLumps must be implemented');
        return [];
    }

    /**
     * Candidate lumps of the finale music (the end-of-chapter story text).
     *
     * @returns {string[]}
     */
    finaleMusicLumps() {
        this._generateException('finaleMusicLumps must be implemented');
        return [];
    }

    /**
     * Candidate music lumps of a level, first present in the WAD wins (the
     * games reuse songs across levels when a WAD carries fewer music lumps
     * than maps).
     *
     * @param {string} levelCode
     * @returns {string[]}
     */
    levelMusicLumps(levelCode) {
        this._generateException('levelMusicLumps must be implemented');
        return [];
    }

    /**
     * Terrain of each flat of this game (the floor entries of the UZDoom
     * TERRAIN lump): flat name (uppercase, EVERY animation frame) → terrain
     * code declared by terrains(). A flat absent from the table is dry.
     *
     * @returns {object} flat name → terrain code
     */
    terrainFlats() {
        this._generateException('terrainFlats must be implemented');
        return {};
    }

    /**
     * What each terrain code does, transcribed from the splash blocks of the
     * TERRAIN lump. Every component is optional, so one shape covers them all:
     * `base` (the ripple spreading on the spot), `chunk` (the piece thrown out
     * of it) with its `chunkVel`, and `sound`. A terrain declaring none is a
     * liquid that splashes nothing — which is how the Doom family keeps its
     * impact decals filtered without gaining a splash it never had.
     *
     * chunkVel carries the lump's own fields: the velocity is
     * `(Random2() << xVelShift) / 65536` and `(Random2() << yVelShift) / 65536`
     * sideways (null = thrown straight up, the lump's 255 sentinel) and
     * `baseZVel + (Random() << zVelShift) / 65536` upward.
     *
     * @returns {object} terrain code → {base?, chunk?, chunkVel?, sound?}
     */
    terrains() {
        this._generateException('terrains must be implemented');
        return {};
    }

    /**
     * How the converter shows the water line of a liquid sector, from the
     * terrain's footclip: 'sink' lowers the physical floor by it under a sheet
     * at the WAD height (the original's sunk sprites), 'raise' keeps the floor
     * and lays the sheet above it, no higher than the lowest bank, 'none' does
     * nothing. alpha is the sheet's opacity, bedDarkening the share of light
     * the floor under it loses.
     *
     * @returns {{mode: string, alpha: number, bedDarkening: number}}
     */
    liquidSurface() {
        return {mode: 'none', alpha: 1, bedDarkening: 0};
    }

    /**
     * Game this profile answers to in the `if<game>` conditionals of a WAD's
     * TERRAIN lump (ifdoom / ifheretic / ifhexen / ifstrife): a lump written
     * for another game is skipped whole.
     *
     * @returns {string}
     */
    terrainGame() {
        this._generateException('terrainGame must be implemented');
        return '';
    }

    /**
     * Flat → terrain entries of a whole animation family, so a profile names
     * the frames once instead of repeating the terrain on every line.
     *
     * @param {string}   terrain
     * @param {string[]} flats
     * @returns {object}
     */
    static terrainGroup(terrain, flats) {
        const entries = {};
        for (const name of flats) {
            entries[name] = terrain;
        }

        return entries;
    }

    /**
     * Hardcoded texture/flat animation sequences of this game's engine, used
     * when the WAD carries no ANIMATED lump (the lump always wins).
     *
     * @returns {object[]} [{isFlat, frames, speedTics}]
     */
    vanillaAnimSequences() {
        this._generateException('vanillaAnimSequences must be implemented');
        return [];
    }

    /**
     * Wall textures that show a liquid (falls, drips, lava walls), every
     * animation frame: like the liquid flats, they take no impact decal.
     *
     * @returns {string[]}
     */
    liquidWallTextures() {
        return [];
    }

    /**
     * Switch texture pairs hardcoded in this game's engine, used when the WAD
     * carries no SWITCHES lump (the lump always wins). Each pair is
     * registered in both directions.
     *
     * @returns {string[][]} [[offName, onName], …]
     */
    switchPairs() {
        this._generateException('switchPairs must be implemented');
        return [];
    }

    /**
     * Sky texture + horizontal wrap for a level.
     *
     * @param {string} levelCode
     * @returns {{name: string, wrap: number}}
     */
    skyForLevel(levelCode) {
        this._generateException('skyForLevel must be implemented');
        return {};
    }

    /**
     * External decal graphics of this game (loaded once at app startup, for
     * every registered profile — keys must be unique across games).
     *
     * @returns {{basePath: string, keys: string[]}}
     */
    decalAssets() {
        this._generateException('decalAssets must be implemented');
        return {};
    }

    /**
     * Every PNG this game draws from outside the WAD, decoded once at startup:
     * its own decal graphics, and the generic splash masks.
     *
     * @returns {{basePath: string, keys: string[]}[]}
     */
    imageAssets() {
        const splash = this.genericSplash();
        const keys   = [];
        for (const part of splash.parts) {
            for (const frame of part.frames) {
                keys.push(frame.key);
            }
        }

        return [this.decalAssets(), {basePath: splash.basePath, keys: keys}];
    }

    /**
     * The splash shown on a liquid this game describes none for: our own
     * masks, colourised at level load with the flat's average colour
     * (DoomGenericSplash).
     *
     * The masks are greyscale PNGs with alpha (alpha = shape, red = luminance);
     * world size = pixel size / pixelsPerUnit, so a redraw at another
     * resolution scales that figure. Each frame is cropped and carries its
     * anchor in its own pixels, like a sprite's leftOffset / topOffset; the
     * anchors were measured against the Heretic SPSH sprites they replace.
     *
     * @returns {object}
     */
    genericSplash() {
        return {
            basePath: '/assets/spipu/splash/',
            // The chunk is thrown like Heretic's water chunk (terrain.txt),
            // and tumbles: each one is drawn within 90° either side of
            // upright, which no original game does.
            chunkVel: {xVelShift: 8, yVelShift: 8, zVelShift: 8, baseZVel: 2},
            chunkSpin: 90,
            // Tinted with the flat's own average colour, the translucent splash
            // would vanish into it: this gain lifts it off its background.
            tintGain: 1.3,
            parts: [
                {
                    part: 'base', sprite: 'SPLB', alpha: 0.7, rise: 0, additive: false, bright: false, mirror: true,
                    pixelsPerUnit: 3.65,
                    frames: [
                        {letter: 'A', key: 'base-1', tics: 5, anchorX: 54, anchorY:  30},
                        {letter: 'B', key: 'base-2', tics: 5, anchorX: 56, anchorY:  63},
                        {letter: 'C', key: 'base-3', tics: 5, anchorX: 60, anchorY: 100},
                        {letter: 'D', key: 'base-4', tics: 5, anchorX: 49, anchorY:  60},
                        {letter: 'E', key: 'base-5', tics: 5, anchorX: 50, anchorY:  38},
                        {letter: 'F', key: 'base-6', tics: 5, anchorX: 56, anchorY:  30},
                        {letter: 'G', key: 'base-7', tics: 5, anchorX: 36, anchorY:  10}
                    ]
                },
                {
                    part: 'chunk', sprite: 'SPLC', alpha: 0.7, rise: 0, gravity: 0.125, additive: false, bright: false, mirror: true,
                    pixelsPerUnit: 5.43,
                    frames: [
                        {letter: 'A', key: 'chunk-1', tics: 8,  anchorX: 14, anchorY: 27},
                        {letter: 'B', key: 'chunk-2', tics: 8,  anchorX: 12, anchorY: 25},
                        {letter: 'C', key: 'chunk-3', tics: 8,  anchorX: 13, anchorY: 24},
                        {letter: 'D', key: 'chunk-4', tics: 16, anchorX:  5, anchorY: 10}
                    ],
                    // Replayed where it falls back into the liquid, like the
                    // Death state of the Heretic chunk.
                    landing: {letters: ['D'], frameTics: [10], bright: false}
                }
            ]
        };
    }

    /**
     * Impact decal templates (decaldef data): per type, the graphics keys and
     * their scale/shade/translucency/gain — shade 'bfg' resolves to
     * bfgDecalShade(). fade marks the fading (GoAway2) templates.
     *
     * @returns {object[]}
     */
    decalTemplates() {
        this._generateException('decalTemplates must be implemented');
        return [];
    }

    /**
     * Transcribed finale-text catalog of this game, merged into the translator
     * at app startup. Its codes are namespaced by this profile's code
     * ('finale.doom.E1TEXT'), so a game whose WAD carries its own texts
     * (Freedoom, through DEHACKED) declares none and falls back on them.
     *
     * @returns {string|null} catalog URL, null when the game ships no text
     */
    finaleAssets() {
        return null;
    }

    /**
     * URL of the map patch catalog of this game (UZDoom LevelCompatibility
     * transcribed, keyed by map fingerprint), null when the game has none.
     *
     * @returns {string|null}
     */
    levelPatchAssets() {
        return null;
    }

    /**
     * Transient effect templates (hitscan puffs, projectile explosions,
     * blood, teleport fog): short sprite animations built once per level in
     * the load batch. rise is the upward drift in map units/tic (0 = static),
     * gravity its per-tic decay; shorten opts out of the Doom first-frame tic
     * cut; meleeStart is the frame index a melee hit starts the puff at;
     * spawnHeight lifts the spawn point (gameinfo telefogheight, Doom units);
     * bright names the Bright frames, which ignore the sector light: true or
     * false for the whole timeline, or one flag per letter (a landing too).
     *
     * @returns {object[]} [{name, sprite, letters, frameTics, alpha, rise,
     *                       additive, bright, gravity?, shorten?, meleeStart?, spawnHeight?}]
     */
    effectTemplates() {
        this._generateException('effectTemplates must be implemented');
        return [];
    }

    /**
     * Projectile definitions: in-flight sprite frames, speed (map units/tic),
     * in-flight alpha, death effect template, wall decal. Optional: gravity
     * (map units/tic², applied after gravityDelayTics of straight flight,
     * with the horizontal speed rescaled to dropSpeed and the vertical speed
     * halved at dropoff) and trailEffect (template spawned every
     * trailEveryTics of flight — set the two together).
     *
     * A monster's shot adds: fastSpeed (the nightmare skill's FastSpeed),
     * seek (homing — {threshold, turnMax} in degrees, everyTics = the cadence
     * of the vanilla action), ripper (a shot that passes THROUGH bodies and
     * grinds them — {damage, damageEvery, shove, lift}), lifeTics (a forced
     * lifetime), growRise (map units climbed per tic while growing) and
     * floorHugger (it crawls along the floor).
     *
     * @returns {object[]} [{kind, sprite, letters, speed, flightTics, explosion, splashDamage, alpha, additive, decalType, gravity?, gravityDelayTics?, dropSpeed?, trailEffect?, trailEveryTics?, fastSpeed?, seek?, ripper?, lifeTics?, growRise?, floorHugger?}]
     */
    projectileDefs() {
        this._generateException('projectileDefs must be implemented');
        return [];
    }

    /**
     * Weapon preference order when the current weapon runs dry
     * (P_CheckAmmo): the first owned entry with enough ammo wins. min
     * overrides the ammo threshold (default = the weapon's perShot); the
     * last entry is the unconditional fallback.
     *
     * @returns {object[]} [{code, min?}]
     */
    weaponFallbackOrder() {
        this._generateException('weaponFallbackOrder must be implemented');
        return [];
    }

    /**
     * Armour granted by the full-kit test cheat — the best armour class of
     * this game.
     *
     * @returns {{points: number, absorb: number}}
     */
    cheatKitArmor() {
        this._generateException('cheatKitArmor must be implemented');
        return {};
    }

    _generateException(msg) {
        throw new Error('GameProfile - ' + msg);
    }
}

class DefaultGameProfile extends AbstractGameProfile {
    getCode() {
        return 'default';
    }

    progressionRules() {
        return {
            // Map entered when leaving the secret ExM9 of each episode
            episodeSecretReturns: {1: 'E1M4', 2: 'E2M6', 3: 'E3M7', 4: 'E4M3'},
            // ExM<n> whose NORMAL exit ends the game (vanilla ga_victory);
            // its secret exit still routes to ExM9
            episodeEndMap: 8,
            // MAPxx secret slots and where their normal exit returns
            mapSecretSlot:      'MAP31',
            mapSuperSecretSlot: 'MAP32',
            mapSecretReturn:    'MAP16',
            // MAPxx whose BOTH exits end the game (cast call)
            mapEndSlot:         'MAP30',
            // Per-map route overrides {name: {next, nextsecret}} — pattern
            // exceptions like the Heretic hidden-episode loop
            explicitRoutes:     {},
            // Story clusters (UZDoom mapinfo/doom1.txt + mapinfo/doom2.txt):
            // the CODE of the text shown on leaving the cluster's last map, or
            // on entering it. ExMy and MAPxx share the table — id numbered the
            // Doom II clusters from 5 so the two families never collide.
            clusters: {
                byEpisode:  true,                                 // ExMy → cluster = episode digit
                byMapRange: [[6, 5], [11, 6], [20, 7], [30, 8]],  // MAPxx up to n → cluster
                byMapExact: {MAP31: 9, MAP32: 10},
                texts: {
                    1: {exit: 'E1TEXT'}, 2: {exit: 'E2TEXT'}, 3: {exit: 'E3TEXT'}, 4: {exit: 'E4TEXT'},
                    5: {exit: 'C1TEXT'}, 6: {exit: 'C2TEXT'}, 7: {exit: 'C3TEXT'}, 8: {exit: 'C4TEXT'},
                    9: {enter: 'C5TEXT'}, 10: {enter: 'C6TEXT'}
                }
            }
        };
    }

    // An unknown doom-format WAD gets no episode names (bare numbered
    // entries) — the id titles belong to the Doom profile, not the fallback.
    episodeNames() {
        return {};
    }

    // Same rule for the level names: an unknown WAD only names its levels
    // through its own lumps (UMAPINFO, DEHACKED).
    levelNames() {
        return {};
    }

    levelNameStringPrefix() {
        return 'HUSTR';
    }

    // Transcription of the A_BossDeath switch (linuxdoom p_enemy.c): specials
    // 38 = lowerFloorToLowest, 109 = blazeOpen, 30 = raiseToTexture. E2M8 and
    // E3M8 fall through to G_ExitLevel — their only exit.
    bossActions() {
        return {
            'E1M8':    {special: 38,  tag: 666},
            'E2M8':    {exit: true},
            'E3M8':    {exit: true},
            'E4M6':    {special: 109, tag: 666},
            'E4M8':    {special: 38,  tag: 666},
            'MAP07-1': {special: 38,  tag: 666},
            'MAP07-2': {special: 30,  tag: 667},
            // A_KeenDie is a hardwired open-stay door on tag 666: declared
            // here so the boss machinery builds and fires it like any other.
            'MAP32':   {special: 103, tag: 666}
        };
    }

    // Bodies that appear without ever being placed on the map: the lost soul a
    // pain elemental spits, and everything the Icon of Sin sends down in a cube
    // (bossCubeSpawns). Their views are built with the level — a runtime spawn
    // has no second chance to load a sprite.
    runtimeSpawnTypes() {
        return ['lostsoul'].concat(DefaultGameProfile.BOSS_CUBE_SPAWNS.map((entry) => entry.kind));
    }

    /**
     * What a boss cube hatches, as the vanilla weighted ladder over a 0..255
     * roll (SpawnFly): the first entry whose `below` exceeds the roll wins, the
     * last one catches everything above. Transcribed from bossbrain.zs.
     *
     * @returns {object[]} [{below, kind}] in rising order
     */
    bossCubeSpawns() {
        return DefaultGameProfile.BOSS_CUBE_SPAWNS;
    }

    // linuxdoom p_mobj.c P_SpawnMapThing: types 1 to 4 fill playerstarts[type - 1];
    // Heretic keeps them.
    playerStartTypes() {
        return [1, 2, 3, 4];
    }

    // linuxdoom p_mobj.c P_SpawnMapThing: type 11 fills deathmatchstarts; Heretic keeps it.
    deathmatchStartType() {
        return 11;
    }

    playerBodyData() {
        return DefaultGameProfile.PLAYER_BODY;
    }

    // Netgame pickups (p_inter.c): P_GiveWeapon leaves a placed weapon on the
    // ground (not a dropped one), P_TouchSpecialThing returns before removing a
    // key. Heretic keeps both.
    multiplayerItemRules() {
        return DefaultGameProfile.MULTIPLAYER_ITEM_RULES;
    }

    // p_mobj.c P_RemoveMobj / P_RespawnSpecials: 30 s, an item fog and itmbk,
    // never the invulnerability (MT_INV) nor the invisibility (MT_INS).
    itemRespawnRules() {
        return DefaultGameProfile.ITEM_RESPAWN_RULES;
    }

    // zscript doomplayer.zs Player.ColorRange and Colorset 0-3: green, gray, brown, red.
    playerColors() {
        return DefaultGameProfile.PLAYER_COLORS;
    }

    // mapinfo/doom2.txt (and tnt/plutonia): only the Icon of Sin's arena lets
    // a teleporting monster stomp — the cubes land on occupied spots.
    monsterTelefragMaps() {
        return ['MAP30'];
    }

    bfgDecalShade() {
        return [128, 255, 128];
    }

    // World things of the Doom family: decoration definitions (radius in
    // metres, ≈ Doom radius / 64 — only used by the collision phase) and the
    // editor-number table. Sprite names/flags follow the Doom Wiki thing-type
    // table; animated things list their frames + duration per entry.
    thingDecorations() {
        return {
            floorLamp:     new DoomDecoration({code: 'floorLamp',     name: 'Floor lamp',         sprite: 'COLUA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            techColumn:    new DoomDecoration({code: 'techColumn',    name: 'Tall techno column', sprite: 'ELECA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            candelabra:    new DoomDecoration({code: 'candelabra',    name: 'Candelabra',         sprite: 'CBRAA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            pillarTallG:   new DoomDecoration({code: 'pillarTallG',   name: 'Tall green pillar',  sprite: 'COL1A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            pillarShortG:  new DoomDecoration({code: 'pillarShortG',  name: 'Short green pillar', sprite: 'COL2A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            pillarTallR:   new DoomDecoration({code: 'pillarTallR',   name: 'Tall red pillar',    sprite: 'COL3A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            pillarShortR:  new DoomDecoration({code: 'pillarShortR',  name: 'Short red pillar',   sprite: 'COL4A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            pillarHeart:   new DoomDecoration({code: 'pillarHeart',   name: 'Pillar with heart',  sprite: 'COL5A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            pillarSkull:   new DoomDecoration({code: 'pillarSkull',   name: 'Pillar with skull',  sprite: 'COL6A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            evilEye:       new DoomDecoration({code: 'evilEye',       name: 'Evil eye',           sprite: 'CEYEA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            floatSkull:    new DoomDecoration({code: 'floatSkull',    name: 'Floating skull',     sprite: 'FSKUA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            burntTree:     new DoomDecoration({code: 'burntTree',     name: 'Burnt tree',         sprite: 'TRE1A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            bigTree:       new DoomDecoration({code: 'bigTree',       name: 'Big brown tree',     sprite: 'TRE2A0', solid: true,  radius: 32 * WadConstants.SCALE}),
            stalagmite:    new DoomDecoration({code: 'stalagmite',    name: 'Stalagmite',         sprite: 'SMITA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            impaledHuman:  new DoomDecoration({code: 'impaledHuman',  name: 'Impaled human',      sprite: 'POL1A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            twitchImpaled: new DoomDecoration({code: 'twitchImpaled', name: 'Twitching impaled',  sprite: 'POL6A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            skullPole:     new DoomDecoration({code: 'skullPole',     name: 'Skull on a pole',    sprite: 'POL4A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            skullKebab:    new DoomDecoration({code: 'skullKebab',    name: 'Skulls kebab',       sprite: 'POL2A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            skullPile:     new DoomDecoration({code: 'skullPile',     name: 'Skulls and candles', sprite: 'POL3A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            burningBarrel: new DoomDecoration({code: 'burningBarrel', name: 'Burning barrel',     sprite: 'FCANA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            tallBlueTorch: new DoomDecoration({code: 'tallBlueTorch', name: 'Tall blue torch',    sprite: 'TBLUA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            tallGreenTorch: new DoomDecoration({code: 'tallGreenTorch', name: 'Tall green torch',   sprite: 'TGRNA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            tallRedTorch:  new DoomDecoration({code: 'tallRedTorch',  name: 'Tall red torch',     sprite: 'TREDA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            shortBlueTorch: new DoomDecoration({code: 'shortBlueTorch', name: 'Short blue torch',   sprite: 'SMBTA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            shortGreenTorch: new DoomDecoration({code: 'shortGreenTorch', name: 'Short green torch', sprite: 'SMGTA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            shortRedTorch: new DoomDecoration({code: 'shortRedTorch', name: 'Short red torch',    sprite: 'SMRTA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            tallTechLamp:  new DoomDecoration({code: 'tallTechLamp',  name: 'Tall techno lamp',   sprite: 'TLMPA0', solid: true,  radius: 16 * WadConstants.SCALE}),
            shortTechLamp: new DoomDecoration({code: 'shortTechLamp', name: 'Short techno lamp',  sprite: 'TLP2A0', solid: true,  radius: 16 * WadConstants.SCALE}),
            candle:        new DoomDecoration({code: 'candle',        name: 'Candle',             sprite: 'CANDA0', solid: false, radius: 0}),
            gibs:          new DoomDecoration({code: 'gibs',          name: 'Bloody mess',        sprite: 'PLAYW0', solid: false, radius: 0}),
            deadPlayer:    new DoomDecoration({code: 'deadPlayer',    name: 'Dead player',        sprite: 'PLAYN0', solid: false, radius: 0}),
            deadFormer:    new DoomDecoration({code: 'deadFormer',    name: 'Dead former human',  sprite: 'POSSL0', solid: false, radius: 0}),
            deadSergeant:  new DoomDecoration({code: 'deadSergeant',  name: 'Dead sergeant',      sprite: 'SPOSL0', solid: false, radius: 0}),
            deadImp:       new DoomDecoration({code: 'deadImp',       name: 'Dead imp',           sprite: 'TROOM0', solid: false, radius: 0}),
            deadDemon:     new DoomDecoration({code: 'deadDemon',     name: 'Dead demon',         sprite: 'SARGN0', solid: false, radius: 0}),
            deadCaco:      new DoomDecoration({code: 'deadCaco',      name: 'Dead cacodemon',     sprite: 'HEADL0', solid: false, radius: 0}),
            gutsPool:      new DoomDecoration({code: 'gutsPool',      name: 'Pool of guts',       sprite: 'POL5A0', solid: false, radius: 0}),
            poolBlood1:    new DoomDecoration({code: 'poolBlood1',    name: 'Pool of blood',      sprite: 'POB1A0', solid: false, radius: 0}),
            poolBlood2:    new DoomDecoration({code: 'poolBlood2',    name: 'Pool of blood',      sprite: 'POB2A0', solid: false, radius: 0}),
            poolBrains:    new DoomDecoration({code: 'poolBrains',    name: 'Pool of brains',     sprite: 'BRS1A0', solid: false, radius: 0}),
            // Ceiling-hung (solid set per type; anchored to the ceiling)
            hangTwitching: new DoomDecoration({code: 'hangTwitching', name: 'Hanging twitching',  sprite: 'GOR1A0', solid: false, radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangArmsOut:   new DoomDecoration({code: 'hangArmsOut',   name: 'Hanging arms out',   sprite: 'GOR2A0', solid: false, radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangOneLeg:    new DoomDecoration({code: 'hangOneLeg',    name: 'Hanging one-legged', sprite: 'GOR3A0', solid: false, radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangLegsPair:  new DoomDecoration({code: 'hangLegsPair',  name: 'Hanging pair of legs', sprite: 'GOR4A0', solid: false, radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangLeg:       new DoomDecoration({code: 'hangLeg',       name: 'Hanging leg',        sprite: 'GOR5A0', solid: false, radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangGuts1:     new DoomDecoration({code: 'hangGuts1',     name: 'Hanging victim guts', sprite: 'HDB1A0', solid: true,  radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangGuts2:     new DoomDecoration({code: 'hangGuts2',     name: 'Hanging guts/brain', sprite: 'HDB2A0', solid: true,  radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangTorso1:    new DoomDecoration({code: 'hangTorso1',    name: 'Hanging torso down', sprite: 'HDB3A0', solid: true,  radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangTorso2:    new DoomDecoration({code: 'hangTorso2',    name: 'Hanging torso open', sprite: 'HDB4A0', solid: true,  radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangTorso3:    new DoomDecoration({code: 'hangTorso3',    name: 'Hanging torso 1leg', sprite: 'HDB5A0', solid: true,  radius: 16 * WadConstants.SCALE, ceiling: true}),
            hangTorso4:    new DoomDecoration({code: 'hangTorso4',    name: 'Hanging torso noleg', sprite: 'HDB6A0', solid: true,  radius: 16 * WadConstants.SCALE, ceiling: true})
        };
    }

    thingTypes() {
        return {
            // --- Icon of Sin plumbing ---
            // BossTarget: not a body, only a spot the boss cubes are sent to,
            // taken in map order (the eye rotates through them).
            87:   {kind: 'spot', group: 'bossTarget'},
            // --- Weapons ---
            2001: {kind: 'pickup', sprite: 'SHOTA0', effect: {weapon: 'shotgun'}},
            82:   {kind: 'pickup', sprite: 'SGN2A0', effect: {weapon: 'supershotgun'}},
            2002: {kind: 'pickup', sprite: 'MGUNA0', effect: {weapon: 'chaingun'}},
            2003: {kind: 'pickup', sprite: 'LAUNA0', effect: {weapon: 'rocket'}},
            2004: {kind: 'pickup', sprite: 'PLASA0', effect: {weapon: 'plasma'}},
            2005: {kind: 'pickup', sprite: 'CSAWA0', effect: {weapon: 'chainsaw'}},
            2006: {kind: 'pickup', sprite: 'BFUGA0', effect: {weapon: 'bfg'}},
            // --- Ammo ---
            2007: {kind: 'pickup', sprite: 'CLIPA0', effect: {ammo: 'bullets', amount: 10}},
            2048: {kind: 'pickup', sprite: 'AMMOA0', effect: {ammo: 'bullets', amount: 50}},
            2008: {kind: 'pickup', sprite: 'SHELA0', effect: {ammo: 'shells', amount: 4}},
            2049: {kind: 'pickup', sprite: 'SBOXA0', effect: {ammo: 'shells', amount: 20}},
            2010: {kind: 'pickup', sprite: 'ROCKA0', effect: {ammo: 'rockets', amount: 1}},
            2046: {kind: 'pickup', sprite: 'BROKA0', effect: {ammo: 'rockets', amount: 5}},
            2047: {kind: 'pickup', sprite: 'CELLA0', effect: {ammo: 'cells', amount: 20}},
            17:   {kind: 'pickup', sprite: 'CELPA0', effect: {ammo: 'cells', amount: 100}},
            8:    {kind: 'pickup', sprite: 'BPAKA0', effect: {backpack: true}},
            // --- Health / armor (bonuses + spheres blink) ---
            2011: {kind: 'pickup', sprite: 'STIMA0', effect: {health: 10}},
            2012: {kind: 'pickup', sprite: 'MEDIA0', effect: {health: 25}},
            2014: {kind: 'pickup', sprite: 'BON1A0', frames: DoomThingCatalog.animFrames('BON1', 'ABCDCB'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {health: 1, overheal: true}},
            2015: {kind: 'pickup', sprite: 'BON2A0', frames: DoomThingCatalog.animFrames('BON2', 'ABCDCB'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {armorBonus: 1, absorb: (1 / 3)}},
            2018: {kind: 'pickup', sprite: 'ARM1A0', frames: DoomThingCatalog.animFrames('ARM1', 'AB'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {armor: {points: 100, absorb: (1 / 3)}}},
            2019: {kind: 'pickup', sprite: 'ARM2A0', frames: DoomThingCatalog.animFrames('ARM2', 'AB'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {armor: {points: 200, absorb: 0.5}}},
            2013: {kind: 'pickup', sprite: 'SOULA0', frames: DoomThingCatalog.animFrames('SOUL', 'ABCDCB'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {health: 100, overheal: true}},
            83:   {kind: 'pickup', sprite: 'MEGAA0', frames: DoomThingCatalog.animFrames('MEGA', 'ABCD'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {mega: {health: 200, armor: {points: 200, absorb: 0.5}}}},
            // --- Power-ups ---
            2022: {kind: 'pickup', sprite: 'PINVA0', frames: DoomThingCatalog.animFrames('PINV', 'ABCD'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {item: 'invulnerability'}},
            2023: {kind: 'pickup', sprite: 'PSTRA0', effect: {item: 'berserk'}},
            2024: {kind: 'pickup', sprite: 'PINSA0', frames: DoomThingCatalog.animFrames('PINS', 'ABCD'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {item: 'invisibility'}},
            2025: {kind: 'pickup', sprite: 'SUITA0', effect: {item: 'radiationSuit'}},
            2026: {kind: 'pickup', sprite: 'PMAPA0', frames: DoomThingCatalog.animFrames('PMAP', 'ABCD'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {item: 'computerMap'}},
            2045: {kind: 'pickup', sprite: 'PVISA0', frames: DoomThingCatalog.animFrames('PVIS', 'AB'), animDuration: 6 * WadConstants.SECONDS_PER_TIC, effect: {item: 'lightVisor'}},
            // --- Keys (blink between two frames; +NOTDMATCH, doomkeys.zs) ---
            5:    {kind: 'pickup', sprite: 'BKEYA0', frames: DoomThingCatalog.animFrames('BKEY', 'AB'), animDuration: 7 * WadConstants.SECONDS_PER_TIC, effect: {item: 'blueKey'}, notDeathmatch: true},
            13:   {kind: 'pickup', sprite: 'RKEYA0', frames: DoomThingCatalog.animFrames('RKEY', 'AB'), animDuration: 7 * WadConstants.SECONDS_PER_TIC, effect: {item: 'redKey'}, notDeathmatch: true},
            6:    {kind: 'pickup', sprite: 'YKEYA0', frames: DoomThingCatalog.animFrames('YKEY', 'AB'), animDuration: 7 * WadConstants.SECONDS_PER_TIC, effect: {item: 'yellowKey'}, notDeathmatch: true},
            40:   {kind: 'pickup', sprite: 'BSKUA0', frames: DoomThingCatalog.animFrames('BSKU', 'AB'), animDuration: 7 * WadConstants.SECONDS_PER_TIC, effect: {item: 'blueKey'}, notDeathmatch: true},
            38:   {kind: 'pickup', sprite: 'RSKUA0', frames: DoomThingCatalog.animFrames('RSKU', 'AB'), animDuration: 7 * WadConstants.SECONDS_PER_TIC, effect: {item: 'redKey'}, notDeathmatch: true},
            39:   {kind: 'pickup', sprite: 'YSKUA0', frames: DoomThingCatalog.animFrames('YSKU', 'AB'), animDuration: 7 * WadConstants.SECONDS_PER_TIC, effect: {item: 'yellowKey'}, notDeathmatch: true},
            // --- Static floor decorations ---
            2028: {kind: 'decoration', code: 'floorLamp'},
            48:   {kind: 'decoration', code: 'techColumn'},
            35:   {kind: 'decoration', code: 'candelabra'},
            34:   {kind: 'decoration', code: 'candle'},
            30:   {kind: 'decoration', code: 'pillarTallG'},
            31:   {kind: 'decoration', code: 'pillarShortG'},
            32:   {kind: 'decoration', code: 'pillarTallR'},
            33:   {kind: 'decoration', code: 'pillarShortR'},
            37:   {kind: 'decoration', code: 'pillarSkull'},
            43:   {kind: 'decoration', code: 'burntTree'},
            54:   {kind: 'decoration', code: 'bigTree'},
            47:   {kind: 'decoration', code: 'stalagmite'},
            25:   {kind: 'decoration', code: 'impaledHuman'},
            27:   {kind: 'decoration', code: 'skullPole'},
            28:   {kind: 'decoration', code: 'skullKebab'},
            24:   {kind: 'decoration', code: 'gutsPool'},
            79:   {kind: 'decoration', code: 'poolBlood1'},
            80:   {kind: 'decoration', code: 'poolBlood2'},
            81:   {kind: 'decoration', code: 'poolBrains'},
            15:   {kind: 'decoration', code: 'deadPlayer'},
            18:   {kind: 'decoration', code: 'deadFormer'},
            19:   {kind: 'decoration', code: 'deadSergeant'},
            20:   {kind: 'decoration', code: 'deadImp'},
            21:   {kind: 'decoration', code: 'deadDemon'},
            22:   {kind: 'decoration', code: 'deadCaco'},
            10:   {kind: 'decoration', code: 'gibs'},
            12:   {kind: 'decoration', code: 'gibs'},
            // --- Animated floor decorations ---
            36:   {kind: 'decoration', code: 'pillarHeart',     frames: DoomThingCatalog.animFrames('COL5', 'AB'),    animDuration: 10 * WadConstants.SECONDS_PER_TIC},
            41:   {kind: 'decoration', code: 'evilEye',         frames: DoomThingCatalog.animFrames('CEYE', 'ABCB'),  animDuration: 6 * WadConstants.SECONDS_PER_TIC},
            42:   {kind: 'decoration', code: 'floatSkull',      frames: DoomThingCatalog.animFrames('FSKU', 'ABC'),   animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            26:   {kind: 'decoration', code: 'twitchImpaled',   frames: DoomThingCatalog.animFrames('POL6', 'AB'),    animDuration: 7 * WadConstants.SECONDS_PER_TIC},
            29:   {kind: 'decoration', code: 'skullPile',       frames: DoomThingCatalog.animFrames('POL3', 'AB'),    animDuration: 7 * WadConstants.SECONDS_PER_TIC},
            70:   {kind: 'decoration', code: 'burningBarrel',   frames: DoomThingCatalog.animFrames('FCAN', 'ABC'),   animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            44:   {kind: 'decoration', code: 'tallBlueTorch',   frames: DoomThingCatalog.animFrames('TBLU', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            45:   {kind: 'decoration', code: 'tallGreenTorch',  frames: DoomThingCatalog.animFrames('TGRN', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            46:   {kind: 'decoration', code: 'tallRedTorch',    frames: DoomThingCatalog.animFrames('TRED', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            55:   {kind: 'decoration', code: 'shortBlueTorch',  frames: DoomThingCatalog.animFrames('SMBT', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            56:   {kind: 'decoration', code: 'shortGreenTorch', frames: DoomThingCatalog.animFrames('SMGT', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            57:   {kind: 'decoration', code: 'shortRedTorch',   frames: DoomThingCatalog.animFrames('SMRT', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            85:   {kind: 'decoration', code: 'tallTechLamp',    frames: DoomThingCatalog.animFrames('TLMP', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            86:   {kind: 'decoration', code: 'shortTechLamp',   frames: DoomThingCatalog.animFrames('TLP2', 'ABCD'),  animDuration: 4 * WadConstants.SECONDS_PER_TIC},
            // --- Ceiling-hung decorations (solid set per type) ---
            49:   {kind: 'decoration', code: 'hangTwitching', solid: true,  frames: DoomThingCatalog.animFrames('GOR1', 'ABC'), animDuration: 7 * WadConstants.SECONDS_PER_TIC},
            63:   {kind: 'decoration', code: 'hangTwitching', solid: false, frames: DoomThingCatalog.animFrames('GOR1', 'ABC'), animDuration: 7 * WadConstants.SECONDS_PER_TIC},
            50:   {kind: 'decoration', code: 'hangArmsOut',   solid: true},
            59:   {kind: 'decoration', code: 'hangArmsOut',   solid: false},
            51:   {kind: 'decoration', code: 'hangOneLeg',    solid: true},
            61:   {kind: 'decoration', code: 'hangOneLeg',    solid: false},
            52:   {kind: 'decoration', code: 'hangLegsPair',  solid: true},
            60:   {kind: 'decoration', code: 'hangLegsPair',  solid: false},
            53:   {kind: 'decoration', code: 'hangLeg',       solid: true},
            62:   {kind: 'decoration', code: 'hangLeg',       solid: false},
            73:   {kind: 'decoration', code: 'hangGuts1'},
            74:   {kind: 'decoration', code: 'hangGuts2'},
            75:   {kind: 'decoration', code: 'hangTorso1'},
            76:   {kind: 'decoration', code: 'hangTorso2'},
            77:   {kind: 'decoration', code: 'hangTorso3'},
            78:   {kind: 'decoration', code: 'hangTorso4'}
        };
    }

    // The MF_COUNTITEM things of info.c: the two bonuses, the two spheres and
    // the power-ups. Deliberate deviation from the zscript, which dropped the
    // flag on RadSuit (doomartifacts.zs): the original counts it.
    countedItemTypes() {
        return new Set([
            2014, 2015,                    // health bonus, armor bonus
            2013, 83,                      // soulsphere, megasphere
            2022, 2023, 2024, 2025, 2026, 2045
        ]);
    }

    // Shared state blocks of the variant families (the spectre is a demon,
    // the hell knight is a baron): one transcription each.
    _demonStates() {
        return {
            spawn: [['AB', 10, 'A_Look', 'spawn']],
            see:   [['AABBCCDD', 2, 'A_Chase', 'see', false, true]],
            melee: [['EF', 8, 'A_FaceTarget', null, false, true], ['G', 8, 'A_SargAttack', 'see', false, true]],
            pain:  [['H', 2, null, null, false, true], ['H', 2, 'A_Pain', 'see', false, true]],
            death: [['I', 8], ['J', 8, 'A_Scream'], ['K', 4], ['L', 4, 'A_NoBlocking'], ['M', 4], ['N', -1]],
            raise: [['N', 5], ['MLKJI', 5, null, 'see']]
        };
    }

    // Baron and hell knight share their species: they never hurt each other.
    _bruiserParams() {
        return {melee: {base: 10, dice: 8}, missile: 'baronBall', species: 'baron'};
    }

    _bruiserStates(withBossDeath) {
        return {
            spawn:   [['AB', 10, 'A_Look', 'spawn']],
            see:     [['AABBCCDD', 3, 'A_Chase', 'see']],
            missile: [['EF', 8, 'A_FaceTarget'], ['G', 8, 'A_BruisAttack', 'see']],
            pain:    [['H', 2], ['H', 2, 'A_Pain', 'see']],
            death:   [['I', 8], ['J', 8, 'A_Scream'], ['K', 8], ['L', 8, 'A_NoBlocking'], ['MN', 8], ['O', -1, ((withBossDeath) ? 'A_BossDeath' : null)]],
            raise:   [['O', 8], ['NMLKJI', 8, null, 'see']]
        };
    }

    // The Doom bestiary, transcribed state-for-state from the UZDoom zscript
    // actors (zscript/actors/doom/*.zs) with the editor numbers of
    // mapinfo/doomitems.txt. Radius/height in Doom units (converted by the
    // consumers). BossTarget 87 / BossEye 89 are Icon-of-Sin plumbing (no
    // body, handled by the boss machinery), Stealth* and ScriptedMarine are
    // ZDoom additions: none of those are spawnable monsters here.
    monsterDefs() {
        return {
            3004: new DoomMonsterDef({
                code: 'zombieman', name: 'Zombieman', sprite: 'POSS',
                health: 20, radius: 20, height: 56, speed: 8, painChance: 200,
                dropItems: [{item: 'Clip'}],
                params: {bullet: DefaultGameProfile.MONSTER_BULLET},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDD', 4, 'A_Chase', 'see']],
                    missile: [['E', 10, 'A_FaceTarget'], ['F', 8, 'A_PosAttack'], ['E', 8, null, 'see']],
                    pain:    [['G', 3], ['G', 3, 'A_Pain', 'see']],
                    death:   [['H', 5], ['I', 5, 'A_Scream'], ['J', 5, 'A_NoBlocking'], ['K', 5], ['L', -1]],
                    xdeath:  [['M', 5], ['N', 5, 'A_XScream'], ['O', 5, 'A_NoBlocking'], ['PQRST', 5], ['U', -1]],
                    raise:   [['K', 5], ['JIH', 5, null, 'see']]
                }
            }),
            9: new DoomMonsterDef({
                code: 'shotgunguy', name: 'Shotgun Guy', sprite: 'SPOS',
                health: 30, radius: 20, height: 56, speed: 8, painChance: 170,
                dropItems: [{item: 'Shotgun'}],
                params: {bullet: DefaultGameProfile.MONSTER_BULLET},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDD', 3, 'A_Chase', 'see']],
                    missile: [['E', 10, 'A_FaceTarget'], ['F', 10, ['A_SposAttackUseAtkSound', {rays: 3}], null, true], ['E', 10, null, 'see']],
                    pain:    [['G', 3], ['G', 3, 'A_Pain', 'see']],
                    death:   [['H', 5], ['I', 5, 'A_Scream'], ['J', 5, 'A_NoBlocking'], ['K', 5], ['L', -1]],
                    xdeath:  [['M', 5], ['N', 5, 'A_XScream'], ['O', 5, 'A_NoBlocking'], ['PQRST', 5], ['U', -1]],
                    raise:   [['L', 5], ['KJIH', 5, null, 'see']]
                }
            }),
            65: new DoomMonsterDef({
                code: 'chaingunguy', name: 'Chaingunner', sprite: 'CPOS',
                health: 70, radius: 20, height: 56, speed: 8, painChance: 170,
                dropItems: [{item: 'Chaingun'}],
                params: {bullet: DefaultGameProfile.MONSTER_BULLET},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDD', 3, 'A_Chase', 'see']],
                    missile: [['E', 10, 'A_FaceTarget'], ['FE', 4, 'A_CPosAttack', null, true], ['F', 1, ['A_CPosRefire', {chance: 40}], 'missile1']],
                    pain:    [['G', 3], ['G', 3, 'A_Pain', 'see']],
                    death:   [['H', 5], ['I', 5, 'A_Scream'], ['J', 5, 'A_NoBlocking'], ['KLM', 5], ['N', -1]],
                    xdeath:  [['O', 5], ['P', 5, 'A_XScream'], ['Q', 5, 'A_NoBlocking'], ['RS', 5], ['T', -1]],
                    raise:   [['N', 5], ['MLKJIH', 5, null, 'see']]
                }
            }),
            84: new DoomMonsterDef({
                code: 'wolfss', name: 'Wolfenstein SS', sprite: 'SSWV',
                health: 50, radius: 20, height: 56, speed: 8, painChance: 170,
                dropItems: [{item: 'Clip'}],
                params: {bullet: DefaultGameProfile.MONSTER_BULLET},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDD', 3, 'A_Chase', 'see']],
                    missile: [['E', 10, 'A_FaceTarget'], ['F', 10, 'A_FaceTarget'], ['G', 4, 'A_CPosAttack', null, true], ['F', 6, 'A_FaceTarget'], ['G', 4, 'A_CPosAttack', null, true], ['F', 1, ['A_CPosRefire', {chance: 40}], 'missile1']],
                    pain:    [['H', 3], ['H', 3, 'A_Pain', 'see']],
                    death:   [['I', 5], ['J', 5, 'A_Scream'], ['K', 5, 'A_NoBlocking'], ['L', 5], ['M', -1]],
                    xdeath:  [['N', 5], ['O', 5, 'A_XScream'], ['P', 5, 'A_NoBlocking'], ['QRSTU', 5], ['V', -1]],
                    raise:   [['M', 5], ['LKJI', 5, null, 'see']]
                }
            }),
            3001: new DoomMonsterDef({
                code: 'imp', name: 'Imp', sprite: 'TROO',
                health: 60, radius: 20, height: 56, speed: 8, painChance: 200,
                params: {melee: {base: 3, dice: 8}, missile: 'impBall', meleeInMissile: true},
                states: {
                    // zscript labels Melee+Missile on the same block
                    // (A_TroopAttack picks claw or fireball by range).
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDD', 3, 'A_Chase', 'see']],
                    missile: [['EF', 8, 'A_FaceTarget'], ['G', 6, 'A_TroopAttack', 'see']],
                    pain:    [['H', 2], ['H', 2, 'A_Pain', 'see']],
                    death:   [['I', 8], ['J', 8, 'A_Scream'], ['K', 6], ['L', 6, 'A_NoBlocking'], ['M', -1]],
                    xdeath:  [['N', 5], ['O', 5, 'A_XScream'], ['P', 5], ['Q', 5, 'A_NoBlocking'], ['RST', 5], ['U', -1]],
                    raise:   [['ML', 8], ['KJI', 6, null, 'see']]
                }
            }),
            3002: new DoomMonsterDef({
                code: 'demon', name: 'Demon', sprite: 'SARG',
                health: 150, radius: 30, height: 56, mass: 400, speed: 10, painChance: 180,
                params: {melee: {base: 4, dice: 10}},
                states: this._demonStates()
            }),
            58: new DoomMonsterDef({
                // zscript Spectre = RenderStyle OptFuzzy / Alpha 0.5; drawn
                // as a 0.3-alpha shadow instead (no software fuzz effect).
                code: 'spectre', name: 'Spectre', sprite: 'SARG', alpha: 0.3,
                health: 150, radius: 30, height: 56, mass: 400, speed: 10, painChance: 180,
                flags: {shadow: true},
                // Species Demon: a spectre and a demon never hurt each other.
                params: {melee: {base: 4, dice: 10}, species: 'demon'},
                states: this._demonStates()
            }),
            3006: new DoomMonsterDef({
                code: 'lostsoul', name: 'Lost Soul', sprite: 'SKUL',
                health: 100, radius: 16, height: 56, mass: 50, speed: 8, painChance: 256,
                flags: {float: true, noGravity: true},
                params: {missileChanceMult: 0.5, chargeDamage: {base: 3, dice: 8}},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn', true]],
                    see:     [['AB', 6, 'A_Chase', 'see', true]],
                    missile: [['C', 10, 'A_FaceTarget', null, true], ['D', 4, 'A_SkullAttack', null, true], ['CD', 4, null, 'missile2', true]],
                    pain:    [['E', 3, null, null, true], ['E', 3, 'A_Pain', 'see', true]],
                    // No corpse: the death sequence ends without a -1 state.
                    death:   [['F', 6, null, null, true], ['G', 6, 'A_Scream', null, true], ['H', 6, null, null, true], ['I', 6, 'A_NoBlocking', null, true], ['J', 6], ['K', 6]]
                }
            }),
            3005: new DoomMonsterDef({
                code: 'cacodemon', name: 'Cacodemon', sprite: 'HEAD',
                health: 400, radius: 31, height: 56, mass: 400, speed: 8, painChance: 128,
                flags: {float: true, noGravity: true},
                params: {melee: {base: 10, dice: 6}, missile: 'cacoBall'},
                states: {
                    spawn:   [['A', 10, 'A_Look', 'spawn']],
                    see:     [['A', 3, 'A_Chase', 'see']],
                    missile: [['B', 5, 'A_FaceTarget'], ['C', 5, 'A_FaceTarget'], ['D', 5, 'A_HeadAttack', 'see', true]],
                    pain:    [['E', 3], ['E', 3, 'A_Pain'], ['F', 6, null, 'see']],
                    death:   [['G', 8], ['H', 8, 'A_Scream'], ['I', 8], ['J', 8], ['K', 8, 'A_NoBlocking'], ['L', -1, 'A_SetFloorClip']],
                    raise:   [['L', 8, 'A_UnSetFloorClip'], ['KJIHG', 8, null, 'see']]
                }
            }),
            69: new DoomMonsterDef({
                code: 'hellknight', name: 'Hell Knight', sprite: 'BOS2',
                health: 500, radius: 24, height: 64, mass: 1000, speed: 8, painChance: 50,
                params: this._bruiserParams(),
                states: this._bruiserStates(false)
            }),
            3003: new DoomMonsterDef({
                code: 'baron', name: 'Baron of Hell', sprite: 'BOSS',
                health: 1000, radius: 24, height: 64, mass: 1000, speed: 8, painChance: 50,
                bossMaps: ['E1M8'],
                params: this._bruiserParams(),
                states: this._bruiserStates(true)
            }),
            66: new DoomMonsterDef({
                code: 'revenant', name: 'Revenant', sprite: 'SKEL',
                health: 300, radius: 20, height: 56, mass: 500, speed: 10, painChance: 100,
                params: {meleeThreshold: 196, missileChanceMult: 0.5, melee: {base: 6, dice: 10}, missile: 'tracer'},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDDEEFF', 2, 'A_Chase', 'see']],
                    melee:   [['G', 0, 'A_FaceTarget'], ['G', 6, 'A_SkelWhoosh'], ['H', 6, 'A_FaceTarget'], ['I', 6, 'A_SkelFist', 'see']],
                    missile: [['J', 0, 'A_FaceTarget', null, true], ['J', 10, 'A_FaceTarget', null, true], ['K', 10, 'A_SkelMissile'], ['K', 10, 'A_FaceTarget', 'see']],
                    pain:    [['L', 5], ['L', 5, 'A_Pain', 'see']],
                    death:   [['LM', 7], ['N', 7, 'A_Scream'], ['O', 7, 'A_NoBlocking'], ['P', 7], ['Q', -1]],
                    raise:   [['Q', 5], ['PONML', 5, null, 'see']]
                }
            }),
            67: new DoomMonsterDef({
                code: 'mancubus', name: 'Mancubus', sprite: 'FATT',
                health: 600, radius: 48, height: 64, mass: 1000, speed: 8, painChance: 80,
                bossMaps: ['MAP07-1'],
                params: {missile: 'fatShot'},
                states: {
                    spawn:   [['AB', 15, 'A_Look', 'spawn']],
                    see:     [['AABBCCDDEEFF', 4, 'A_Chase', 'see']],
                    missile: [['G', 20, 'A_FatRaise'], ['H', 10, ['A_FatAttack1', {angles: [0, 11.25]}], null, true], ['IG', 5, 'A_FaceTarget'], ['H', 10, ['A_FatAttack2', {angles: [0, -11.25]}], null, true], ['IG', 5, 'A_FaceTarget'], ['H', 10, ['A_FatAttack3', {angles: [-5.625, 5.625]}], null, true], ['IG', 5, 'A_FaceTarget', 'see']],
                    pain:    [['J', 3], ['J', 3, 'A_Pain', 'see']],
                    death:   [['K', 6], ['L', 6, 'A_Scream'], ['M', 6, 'A_NoBlocking'], ['NOPQRS', 6], ['T', -1, 'A_BossDeath']],
                    raise:   [['R', 5], ['QPONMLK', 5, null, 'see']]
                }
            }),
            68: new DoomMonsterDef({
                code: 'arachnotron', name: 'Arachnotron', sprite: 'BSPI',
                health: 500, radius: 64, height: 64, mass: 600, speed: 12, painChance: 128,
                bossMaps: ['MAP07-2'],
                params: {missile: 'arachPlasma'},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['A', 20], ['A', 3, 'A_BabyMetal'], ['ABBCC', 3, 'A_Chase'], ['D', 3, 'A_BabyMetal'], ['DEEFF', 3, 'A_Chase', 'see1']],
                    missile: [['A', 20, 'A_FaceTarget', null, true], ['G', 4, 'A_BspiAttack', null, true], ['H', 4, null, null, true], ['H', 1, ['A_SpidRefire', {chance: 10}], 'missile1', true]],
                    pain:    [['I', 3], ['I', 3, 'A_Pain', 'see1']],
                    death:   [['J', 20, 'A_Scream'], ['K', 7, 'A_NoBlocking'], ['LMNO', 7], ['P', -1, 'A_BossDeath']],
                    raise:   [['P', 5], ['ONMLKJ', 5, null, 'see1']]
                }
            }),
            71: new DoomMonsterDef({
                code: 'painelemental', name: 'Pain Elemental', sprite: 'PAIN',
                health: 400, radius: 31, height: 56, mass: 400, speed: 8, painChance: 128,
                flags: {float: true, noGravity: true},
                states: {
                    spawn:   [['A', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCC', 3, 'A_Chase', 'see']],
                    missile: [['D', 5, 'A_FaceTarget'], ['E', 5, 'A_FaceTarget'], ['F', 5, 'A_FaceTarget', null, true], ['F', 0, ['A_PainAttack', {spawn: 'lostsoul'}], 'see', true]],
                    pain:    [['G', 6], ['G', 6, 'A_Pain', 'see']],
                    // A_PainDie bursts into lost souls: no corpse.
                    death:   [['H', 8, null, null, true], ['I', 8, 'A_Scream', null, true], ['JK', 8, null, null, true], ['L', 8, ['A_PainDie', {spawn: 'lostsoul', spawnAngles: [90, 180, 270]}], null, true], ['M', 8, null, null, true]],
                    raise:   [['MLKJIH', 8, null, 'see']]
                }
            }),
            64: new DoomMonsterDef({
                code: 'archvile', name: 'Archvile', sprite: 'VILE',
                health: 700, radius: 20, height: 56, mass: 500, speed: 15, painChance: 10,
                flags: {noTarget: true, quickToRetaliate: true},
                params: {maxTargetRange: 896},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['AABBCCDDEEFF', 2, 'A_VileChase', 'see']],
                    missile: [['G', 0, 'A_VileStart', null, true], ['G', 10, 'A_FaceTarget', null, true], ['H', 8, ['A_VileTarget', {fire: 'vileFire', ahead: 24}], null, true], ['IJKLMN', 8, 'A_FaceTarget', null, true], ['O', 8, ['A_VileAttack', {damage: 20, blastDamage: 70, blastRadius: 70, thrust: 1, ahead: 24}], null, true], ['P', 20, null, 'see', true]],
                    heal:    [['[\\]', 10, null, 'see', true]],
                    pain:    [['Q', 5], ['Q', 5, 'A_Pain', 'see']],
                    death:   [['Q', 7], ['R', 7, 'A_Scream'], ['S', 7, 'A_NoBlocking'], ['TUVWXY', 7], ['Z', -1]]
                }
            }),
            7: new DoomMonsterDef({
                code: 'mastermind', name: 'Spider Mastermind', sprite: 'SPID',
                health: 3000, radius: 128, height: 100, mass: 1000, speed: 12, painChance: 40,
                flags: {boss: true, noRadiusDmg: true},
                bossMaps: ['E3M8', 'E4M8'],
                params: {missileChanceMult: 0.5, bullet: DefaultGameProfile.MONSTER_BULLET},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['A', 3, 'A_Metal'], ['ABB', 3, 'A_Chase'], ['C', 3, 'A_Metal'], ['CDD', 3, 'A_Chase'], ['E', 3, 'A_Metal'], ['EFF', 3, 'A_Chase', 'see']],
                    missile: [['A', 20, 'A_FaceTarget', null, true], ['G', 4, ['A_SPosAttackUseAtkSound', {rays: 3}], null, true], ['H', 4, ['A_SposAttackUseAtkSound', {rays: 3}], null, true], ['H', 1, ['A_SpidRefire', {chance: 10}], 'missile1', true]],
                    pain:    [['I', 3], ['I', 3, 'A_Pain', 'see']],
                    death:   [['J', 20, 'A_Scream'], ['K', 10, 'A_NoBlocking'], ['LMNOPQR', 10], ['S', 30], ['S', -1, 'A_BossDeath']]
                }
            }),
            16: new DoomMonsterDef({
                code: 'cyberdemon', name: 'Cyberdemon', sprite: 'CYBR',
                health: 4000, radius: 40, height: 110, mass: 1000, speed: 16, painChance: 20,
                flags: {boss: true, noRadiusDmg: true},
                bossMaps: ['E2M8', 'E4M6'],
                params: {minMissileChance: 160, missileChanceMult: 0.5, missile: 'rocket'},
                states: {
                    spawn:   [['AB', 10, 'A_Look', 'spawn']],
                    see:     [['A', 3, 'A_Hoof'], ['ABBCC', 3, 'A_Chase'], ['D', 3, 'A_Metal'], ['D', 3, 'A_Chase', 'see']],
                    missile: [['E', 6, 'A_FaceTarget'], ['F', 12, 'A_CyberAttack'], ['E', 12, 'A_FaceTarget'], ['F', 12, 'A_CyberAttack'], ['E', 12, 'A_FaceTarget'], ['F', 12, 'A_CyberAttack', 'see']],
                    pain:    [['G', 10, 'A_Pain', 'see']],
                    death:   [['H', 10], ['I', 10, 'A_Scream'], ['JKL', 10], ['M', 10, 'A_NoBlocking'], ['NO', 10], ['P', 30], ['P', -1, 'A_BossDeath']]
                }
            }),
            72: new DoomMonsterDef({
                code: 'keen', name: 'Commander Keen', sprite: 'KEEN',
                health: 100, radius: 16, height: 72, mass: 10000000, speed: 0, painChance: 256,
                ceiling: true,
                flags: {noGravity: true},
                bossMaps: ['MAP32'],
                states: {
                    spawn: [['A', -1]],
                    pain:  [['M', 4], ['M', 8, 'A_Pain', 'spawn']],
                    death: [['AB', 6], ['C', 6, 'A_Scream'], ['DEFGH', 6], ['I', 6], ['J', 6], ['K', 6, 'A_KeenDie'], ['L', -1]]
                }
            }),
            2035: new DoomMonsterDef({
                // doommisc.zs ExplosiveBarrel: a shootable body, not a kill —
                // its death runs A_Explode (128/128) and the empty end of the
                // sequence despawns it (no respawn).
                code: 'barrel', name: 'Barrel', sprite: 'BAR1',
                health: 20, radius: 10, height: 42, speed: 0, painChance: 0,
                flags: {countsKill: false, noBlood: true, dontGib: true, noCorpseThrust: true},
                params: {explode: {damage: 128, distance: 128}},
                spriteOverrides: {death: 'BEXP'},
                states: {
                    spawn: [['AB', 6, null, 'spawn']],
                    death: [['A', 5, null, null, true], ['B', 5, 'A_Scream', null, true], ['C', 5, null, null, true], ['D', 10, 'A_Explode', null, true], ['E', 10, null, null, true]]
                }
            }),
            88: new DoomMonsterDef({
                code: 'bossbrain', name: 'Boss Brain', sprite: 'BBRN',
                health: 250, radius: 16, height: 16, mass: 10000000, speed: 0, painChance: 255,
                flags: {countsKill: false},
                states: {
                    spawn: [['A', -1]],
                    pain:  [['B', 36, 'A_BrainPain', 'spawn']],
                    // Its scream lays a line of harmless explosions, then
                    // A_BrainDie ends the level (Level.ExitLevel).
                    death: [['A', 100, DefaultGameProfile.BRAIN_SCREAM], ['AA', 10], ['A', -1, 'A_BrainDie']]
                }
            }),
            // The eye watches for the player, then spits a cube every 150
            // tics, forever. +NOBLOCKMAP: nothing collides with it. Deviation:
            // vanilla's +NOSECTOR also keeps it out of the draw, we do show its
            // sprite — on MAP30 it stands sealed behind the boss wall.
            89: new DoomMonsterDef({
                code: 'bosseye', name: 'Boss Eye', sprite: 'SSWV',
                health: 1000, radius: 20, height: 32, mass: 10000000, speed: 0, painChance: 0,
                flags: {countsKill: false, noBlockmap: true, noGravity: true, noTarget: true},
                params: {missile: 'spawnShot'},
                states: {
                    spawn: [['A', 10, 'A_Look', 'spawn']],
                    // See: the awake shout, then the spit loop (Wait = stay on
                    // the last state, so the cube comes every 150 tics).
                    see:   [['A', 181, 'A_BrainAwake'], ['A', 150, 'A_BrainSpit', 'see1']]
                }
            })
        };
    }

    // What the Doom zombies leave behind (zscript DropItem): the dropped clip
    // carries HALF the pickup amount (vanilla MF_DROPPED), dropped weapons
    // flag their halved ammo through effect.dropped.
    dropItemTypes() {
        return {
            Clip:     {sprite: 'CLIPA0', effect: {ammo: 'bullets', amount: 5}},
            Shotgun:  {sprite: 'SHOTA0', effect: {weapon: 'shotgun', dropped: true}},
            Chaingun: {sprite: 'MGUNA0', effect: {weapon: 'chaingun', dropped: true}}
        };
    }

    // Doom skill blocks (UZDoom mapinfo/doomcommon.txt): baby = ammo ×2,
    // damage ×0.5, easy boss brain; nightmare = ammo ×2, fast monsters,
    // instant reaction, 12 s respawn. Skill 0 = skill 3 with PACIFIST
    // monsters: they spawn, wake and chase but never attack (and the Icon's
    // eye never spits) — the boss-death map actions stay reachable.
    skillRules() {
        return {
            0: {spawnFilterBit: 0x02, ammoFactor: 1, damageFactor: 1,   monstersPacifist: true,  fastMonsters: false, instantReaction: false, respawnTicsDelay: 0,       easyBossBrain: false},
            1: {spawnFilterBit: 0x01, ammoFactor: 2, damageFactor: 0.5, monstersPacifist: false, fastMonsters: false, instantReaction: false, respawnTicsDelay: 0,       easyBossBrain: true},
            2: {spawnFilterBit: 0x01, ammoFactor: 1, damageFactor: 1,   monstersPacifist: false, fastMonsters: false, instantReaction: false, respawnTicsDelay: 0,       easyBossBrain: true},
            3: {spawnFilterBit: 0x02, ammoFactor: 1, damageFactor: 1,   monstersPacifist: false, fastMonsters: false, instantReaction: false, respawnTicsDelay: 0,       easyBossBrain: false},
            4: {spawnFilterBit: 0x04, ammoFactor: 1, damageFactor: 1,   monstersPacifist: false, fastMonsters: false, instantReaction: false, respawnTicsDelay: 0,       easyBossBrain: false},
            5: {spawnFilterBit: 0x04, ammoFactor: 2, damageFactor: 1,   monstersPacifist: false, fastMonsters: true,  instantReaction: true,  respawnTicsDelay: 12 * 35, easyBossBrain: false}
        };
    }

    // Shared immutable definitions (the per-player state lives on DoomUser).
    buildAmmoTypes() {
        return {
            bullets: new DoomAmmo({code: 'bullets', name: 'Bullets', maxNormal: 200, maxPack: 400, clip: 10}),
            shells:  new DoomAmmo({code: 'shells',  name: 'Shells',  maxNormal: 50,  maxPack: 100, clip: 4}),
            rockets: new DoomAmmo({code: 'rockets', name: 'Rockets', maxNormal: 50,  maxPack: 100, clip: 1}),
            cells:   new DoomAmmo({code: 'cells',   name: 'Cells',   maxNormal: 300, maxPack: 600, clip: 20})
        };
    }

    // The 9 Doom weapons in canonical loadout order, ported state-for-state
    // from d_items.c / info.c / p_pspr.c. Ranges are in world units (Doom
    // units / 64: MELEERANGE 64 → 1, MISSILERANGE 2048 → 32). Spreads are
    // degrees per DoomRandom difference unit (horizontal <<18 / <<19, the SSG
    // vertical slope <<5 turned into a pitch angle).
    buildWeapons() {
        const MELEE_RANGE = 1.0, HITSCAN_RANGE = 32.0;
        const SPREAD      = 360 / 16384;
        const SSG_H       = 360 / 8192;
        const SSG_V       = (180 / Math.PI) / 2048;
        const GUN_ENTRY   = { ready: 'ready', down: 'down', up: 'up', atk: 'fire1', flash: 'flash1' };

        const weaponDefs = [
            {
                code: 'fist', name: 'Fist', ammoType: null, ammoUse: 0,
                pellets: 1, spreadH: SPREAD, range: MELEE_RANGE,
                damage: {base: 2, dice: 10}, berserkItem: 'berserk', berserkFactor: 10,
                meleeHitSound: '*fist',
                puffType: 'puff', decalType: 'bulletChip',
                viewSprite: 'PUNG', entry: { ready: 'ready', down: 'down', up: 'up', atk: 'fire1' },
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['B', 4, null, 'fire2'], fire2: ['C', 4, 'fireMelee', 'fire3'], fire3: ['D', 5, null, 'fire4'],
                    fire4: ['C', 4, null, 'fire5'], fire5: ['B', 5, 'refire', 'ready'],
                },
            },
            {
                code: 'chainsaw', name: 'Chainsaw', ammoType: null, ammoUse: 0,
                pellets: 1, spreadH: SPREAD, range: MELEE_RANGE,
                damage: {base: 2, dice: 10}, kickback: 0,
                upSound: 'weapons/sawup', meleeHitSound: 'weapons/sawhit', meleeMissSound: 'weapons/sawfull',
                actionSounds: {ready: 'weapons/sawidle'},
                puffType: 'puff', decalType: 'bulletChip',
                viewSprite: 'SAWG', entry: { ready: 'ready', down: 'down', up: 'up', atk: 'fire1' },
                main: {
                    ready: ['C', 4, 'ready', 'readyB'], readyB: ['D', 4, 'ready', 'ready'],
                    down: ['C', 1, 'lower', 'down'], up: ['C', 1, 'raise', 'up'],
                    fire1: ['A', 4, 'fireMelee', 'fire2'], fire2: ['B', 4, 'fireMelee', 'fire3'], fire3: ['B', 0, 'refire', 'ready'],
                },
            },
            {
                code: 'pistol', name: 'Pistol', ammoType: 'bullets', ammoUse: 1,
                pellets: 1, spreadH: SPREAD, range: HITSCAN_RANGE, accurateFirst: true,
                damage: {base: 5, dice: 3},
                puffType: 'puff', decalType: 'bulletChip',
                viewSprite: 'PISG', flashSprite: 'PISF', entry: GUN_ENTRY,
                actionSounds: {fireHitscan: 'weapons/pistol'},
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['A', 4, null, 'fire2'], fire2: ['B', 6, 'fireHitscan', 'fire3'],
                    fire3: ['C', 4, null, 'fire4'], fire4: ['B', 5, 'refire', 'ready'],
                },
                flash: { flash1: ['A', 7, 'light1', null] },
            },
            {
                code: 'shotgun', name: 'Shotgun', ammoType: 'shells', ammoUse: 1,
                pellets: 7, spreadH: SPREAD, range: HITSCAN_RANGE,
                damage: {base: 5, dice: 3},
                puffType: 'puff', decalType: 'bulletChip',
                viewSprite: 'SHTG', flashSprite: 'SHTF', entry: GUN_ENTRY,
                actionSounds: {fireHitscan: 'weapons/shotgf'},
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['A', 3, null, 'fire2'], fire2: ['A', 7, 'fireHitscan', 'fire3'], fire3: ['B', 5, null, 'fire4'],
                    fire4: ['C', 5, null, 'fire5'], fire5: ['D', 4, null, 'fire6'], fire6: ['C', 5, null, 'fire7'],
                    fire7: ['B', 5, null, 'fire8'], fire8: ['A', 3, null, 'fire9'], fire9: ['A', 7, 'refire', 'ready'],
                },
                flash: { flash1: ['A', 4, 'light1', 'flash2'], flash2: ['B', 3, 'light2', null] },
            },
            {
                code: 'supershotgun', name: 'Super Shotgun', ammoType: 'shells', ammoUse: 2,
                pellets: 20, spreadH: SSG_H, spreadV: SSG_V, range: HITSCAN_RANGE,
                damage: {base: 5, dice: 3},
                puffType: 'puff', decalType: 'bulletChip',
                viewSprite: 'SHT2', flashSprite: 'SHT2', entry: GUN_ENTRY,
                actionSounds: {fireHitscan: 'weapons/sshotf', openShotgun2: 'weapons/sshoto', loadShotgun2: 'weapons/sshotl', closeShotgun2: 'weapons/sshotc'},
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['A', 3, null, 'fire2'], fire2: ['A', 7, 'fireHitscan', 'fire3'], fire3: ['B', 7, null, 'fire4'],
                    fire4: ['C', 7, 'checkReload', 'fire5'], fire5: ['D', 7, 'openShotgun2', 'fire6'], fire6: ['E', 7, null, 'fire7'],
                    fire7: ['F', 7, 'loadShotgun2', 'fire8'], fire8: ['G', 6, null, 'fire9'], fire9: ['H', 6, 'closeShotgun2', 'fire10'],
                    fire10: ['A', 5, 'refire', 'ready'],
                },
                flash: { flash1: ['I', 5, 'light1', 'flash2'], flash2: ['J', 4, 'light2', null] },
            },
            {
                code: 'chaingun', name: 'Chaingun', ammoType: 'bullets', ammoUse: 1,
                pellets: 1, spreadH: SPREAD, range: HITSCAN_RANGE, accurateFirst: true,
                damage: {base: 5, dice: 3},
                puffType: 'puff', decalType: 'bulletChip',
                viewSprite: 'CHGG', flashSprite: 'CHGF', entry: GUN_ENTRY,
                actionSounds: {fireHitscanFlash1: 'weapons/chngun', fireHitscanFlash2: 'weapons/chngun'},
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['A', 4, 'fireHitscanFlash1', 'fire2'], fire2: ['B', 4, 'fireHitscanFlash2', 'fire3'], fire3: ['B', 0, 'refire', 'ready'],
                },
                flash: { flash1: ['A', 5, 'light1', null], flash2: ['B', 5, 'light2', null] },
            },
            {
                code: 'rocket', name: 'Rocket Launcher', ammoType: 'rockets', ammoUse: 1,
                projectiles: [{kind: 'rocket'}], autoFire: false,
                viewSprite: 'MISG', flashSprite: 'MISF', entry: GUN_ENTRY,
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['B', 8, 'gunFlash', 'fire2'], fire2: ['B', 12, 'fireProjectiles', 'fire3'], fire3: ['B', 0, 'refire', 'ready'],
                },
                flash: {
                    flash1: ['A', 3, 'light1', 'flash2'], flash2: ['B', 4, null, 'flash3'],
                    flash3: ['C', 4, 'light2', 'flash4'], flash4: ['D', 4, 'light2', null],
                },
            },
            {
                code: 'plasma', name: 'Plasma Rifle', ammoType: 'cells', ammoUse: 1,
                projectiles: [{kind: 'plasma'}],
                viewSprite: 'PLSG', flashSprite: 'PLSF', entry: GUN_ENTRY,
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['A', 3, 'fireProjectilesRandFlash', 'fire2'], fire2: ['B', 20, 'refire', 'ready'],
                },
                flash: { flash1: ['A', 4, 'light1', null], flash2: ['B', 4, 'light1', null] },
            },
            {
                code: 'bfg', name: 'BFG9000', ammoType: 'cells', ammoUse: 40,
                projectiles: [{kind: 'bfg'}], autoFire: false,
                viewSprite: 'BFGG', flashSprite: 'BFGF', entry: GUN_ENTRY,
                actionSounds: {bfgSound: 'weapons/bfgf'},
                main: {
                    ready: ['A', 1, 'ready', 'ready'], down: ['A', 1, 'lower', 'down'], up: ['A', 1, 'raise', 'up'],
                    fire1: ['A', 20, 'bfgSound', 'fire2'], fire2: ['B', 10, 'gunFlash', 'fire3'],
                    fire3: ['B', 10, 'fireProjectiles', 'fire4'], fire4: ['B', 20, 'refire', 'ready'],
                },
                flash: { flash1: ['A', 11, 'light1', 'flash2'], flash2: ['B', 6, 'light2', null] },
            },
        ];

        const catalog = {};
        for (const entry of weaponDefs) {
            catalog[entry.code] = new DoomWeaponDef(entry);
        }
        return catalog;
    }

    // Transient effects (P_SpawnPuff + the projectile death frames from
    // info.c). alpha/additive follow gzdoom: the rocket blast is opaque smoke,
    // the plasma/BFG blasts glow (RenderStyle "Add", Alpha 0.75), every monster
    // fireball and its death glow too (+ZDOOMTRANS actors: imp, cacodemon,
    // baron, mancubus, revenant tracer, arachnotron at 0.75). The puff is
    // lighter than gzdoom's BulletPuff (0.4 vs Alpha 0.5, doommisc.zs), floats
    // up 1 map unit/tic and starts a melee hit at frame C (no bright spark).
    // Bright frames as info.c: only the puff's first, never the blood or smoke.
    effectTemplates() {
        return [
            {name: 'puff',          sprite: 'PUFF', letters: ['A', 'B', 'C', 'D'],           frameTics: [4, 4, 4, 4],       alpha: 0.4,  rise: 1, additive: false, bright: [true, false, false, false], meleeStart: 2},
            {name: 'rocketExplode', sprite: 'MISL', letters: ['B', 'C', 'D'],                frameTics: [8, 6, 4],          alpha: 1,    rise: 0, additive: false, bright: true},
            {name: 'fatShotExplode', sprite: 'MISL', letters: ['B', 'C', 'D'],               frameTics: [8, 6, 4],          alpha: 1,    rise: 0, additive: true, bright: true},
            {name: 'plasmaExplode', sprite: 'PLSE', letters: ['A', 'B', 'C', 'D', 'E'],      frameTics: [4, 4, 4, 4, 4],    alpha: 0.75, rise: 0, additive: true, bright: true},
            {name: 'bfgExplode',    sprite: 'BFE1', letters: ['A', 'B', 'C', 'D', 'E', 'F'], frameTics: [8, 8, 8, 8, 8, 8], alpha: 0.75, rise: 0, additive: true, bright: true},
            {name: 'bfgSprayHit',   sprite: 'BFE2', letters: ['A', 'B', 'C', 'D'],           frameTics: [8, 8, 8, 8],       alpha: 0.75, rise: 0, additive: true, bright: true},
            // P_SpawnBlood: momz 2 under mobj gravity (1/tic²); big hits show
            // the full splash, weaker ones start deeper in (monsterDamageRules).
            {name: 'blood',         sprite: 'BLUD', letters: ['C', 'B', 'A'],                frameTics: [8, 8, 8],          alpha: 1,    rise: 2, gravity: 1, additive: false, bright: false},
            // Every monster missile's Death animation, plus the revenant's
            // smoke trail and the archvile's hellfire.
            {name: 'impBallDeath',     sprite: 'BAL1', letters: ['C', 'D', 'E'],           frameTics: [6, 6, 6],    alpha: 1,   rise: 0, additive: true, bright: true},
            {name: 'cacoBallDeath',    sprite: 'BAL2', letters: ['C', 'D', 'E'],           frameTics: [6, 6, 6],    alpha: 1,   rise: 0, additive: true, bright: true},
            {name: 'baronBallDeath',   sprite: 'BAL7', letters: ['C', 'D', 'E'],           frameTics: [6, 6, 6],    alpha: 1,   rise: 0, additive: true, bright: true},
            {name: 'arachPlasmaDeath', sprite: 'APBX', letters: ['A', 'B', 'C', 'D', 'E'], frameTics: [5, 5, 5, 5, 5], alpha: 0.75, rise: 0, additive: true, bright: true},
            {name: 'tracerDeath',      sprite: 'FBXP', letters: ['A', 'B', 'C'],           frameTics: [8, 6, 4],    alpha: 1,   rise: 0, additive: true, bright: true},
            {name: 'tracerSmoke',      sprite: 'PUFF', letters: ['A', 'B', 'A', 'B', 'C'], frameTics: [4, 4, 4, 4, 4], alpha: 0.5, rise: 1, additive: false, bright: false},
            // SpawnFire: the pillar a boss cube hatches in (same FIRE sprite as
            // the archvile's, its own 8-frame animation).
            {name: 'spawnFire',        sprite: 'FIRE', letters: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
                frameTics: [4, 4, 4, 4, 4, 4, 4, 4], alpha: 1, rise: 0, additive: true, bright: true},
            // A_BrainScream lays these along a line: the rocket's own explosion
            // frames, with the damage disabled (SetDamage(0) in the source);
            // all three Bright as S_BRAINEXPLODE, where zscript leaves D unlit.
            {name: 'brainExplosion',   sprite: 'MISL', letters: ['B', 'C', 'D'], frameTics: [10, 10, 10],
                alpha: 1, rise: 0, additive: false, bright: true},
            {name: 'vileFire',         sprite: 'FIRE', letters: ['A', 'B', 'A', 'B', 'C', 'B', 'C', 'B', 'C', 'D', 'C', 'D', 'C', 'D', 'E', 'D', 'E', 'D', 'E', 'F', 'E', 'F', 'E', 'F', 'G', 'H', 'G', 'H', 'G', 'H'],
                frameTics: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], alpha: 1, rise: 0, additive: true, bright: true, spawnSound: ['vile/firestrt', 'vile/firecrkl']},
            // EV_Teleport fog (zscript TeleportFog: TFOG ABABCDEFGHIJ 6 Bright, RenderStyle Add)
            {name: 'teleportFog',   sprite: 'TFOG', letters: ['A', 'B', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], frameTics: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6], alpha: 1, rise: 0, additive: true, bright: true},
            // P_RespawnSpecials fog (zscript ItemFog: IFOG ABABCDE 6 Bright)
            {name: 'itemFog',       sprite: 'IFOG', letters: ['A', 'B', 'A', 'B', 'C', 'D', 'E'], frameTics: [6, 6, 6, 6, 6, 6, 6], alpha: 1, rise: 0, additive: false, bright: true}
        ];
    }

    // Per-game damage-pipeline numbers (UZDoom gameinfo blocks + P_SpawnBlood
    // quirks): Doom gibs past 1× spawn health, kicks back at 100, and stamps
    // its blood by damage with shortened first tics.
    monsterDamageRules() {
        return {gibFactor: 1, defKickback: 100, bloodTemplate: 'blood', bloodDamageAdvance: true};
    }

    // The vanilla S_GIBS pool (actor.zs GenericCrush).
    crushedCorpseSprite() {
        return 'POL5A0';
    }

    // The three Doom projectiles (MT_ROCKET / MT_PLASMA / MT_BFG, info.c):
    // speed in map units/tic, splash = the rocket's A_Explode 128. The
    // in-flight alpha follows gzdoom (PlasmaBall/BFGBall: RenderStyle "Add",
    // Alpha 0.75; the rocket is a solid missile).
    // impactDamage = the zscript Damage property: a direct body hit rolls
    // ((rng & 7) + 1) × impactDamage (GetMissileDamage). The BFG ball also
    // fires the vanilla A_BFGSpray from the shooter on detonation.
    projectileDefs() {
        return [
            {kind: 'rocket', sprite: 'MISL', letters: ['A'],      speed: 20, flightTics: 1, explosion: 'rocketExplode', splashDamage: 128, impactDamage: 20,  alpha: 1,    additive: false, decalType: 'scorch', seeSound: 'weapons/rocklf', deathSound: 'weapons/rocklx'},
            {kind: 'plasma', sprite: 'PLSS', letters: ['A', 'B'], speed: 25, flightTics: 6, explosion: 'plasmaExplode', splashDamage: 0,   impactDamage: 5,   alpha: 0.75, additive: true,  decalType: 'plasma', seeSound: 'weapons/plasmaf', deathSound: 'weapons/plasmax'},
            {kind: 'bfg',    sprite: 'BFS1', letters: ['A', 'B'], speed: 25, flightTics: 4, explosion: 'bfgExplode',    splashDamage: 0,   impactDamage: 100, alpha: 0.75, additive: true,  decalType: 'bfg', deathSound: 'weapons/bfgx', spray: {rays: 40, damageCount: 15, angle: 90, distance: 1024, effect: 'bfgSprayHit'}},
            // The monsters' shots (zscript/actors/doom/*.zs): no splash but the
            // cyberdemon's, which fires the very rocket the player does.
            {kind: 'impBall',     sprite: 'BAL1', letters: ['A', 'B'], speed: 10, fastSpeed: 20, flightTics: 4, explosion: 'impBallDeath',     splashDamage: 0, impactDamage: 3,  alpha: 1, additive: true, seeSound: 'imp/attack', deathSound: 'imp/shotx'},
            {kind: 'cacoBall',    sprite: 'BAL2', letters: ['A', 'B'], speed: 10, fastSpeed: 20, flightTics: 4, explosion: 'cacoBallDeath',    splashDamage: 0, impactDamage: 5,  alpha: 1, additive: true, seeSound: 'caco/attack', deathSound: 'caco/shotx'},
            {kind: 'baronBall',   sprite: 'BAL7', letters: ['A', 'B'], speed: 15, fastSpeed: 20, flightTics: 4, explosion: 'baronBallDeath',   splashDamage: 0, impactDamage: 8,  alpha: 1, additive: true, seeSound: 'baron/attack', deathSound: 'baron/shotx'},
            {kind: 'arachPlasma', sprite: 'APLS', letters: ['A', 'B'], speed: 25,                flightTics: 5, explosion: 'arachPlasmaDeath', splashDamage: 0, impactDamage: 5,  alpha: 0.75, additive: true, seeSound: 'baby/attack', deathSound: 'baby/shotx'},
            {kind: 'fatShot',     sprite: 'MANF', letters: ['A', 'B'], speed: 20,                flightTics: 4, explosion: 'fatShotExplode',    splashDamage: 0, impactDamage: 8,  alpha: 1, additive: true, seeSound: 'fatso/attack', deathSound: 'fatso/shotx'},
            // A_Tracer: the smoke and the course correction both run one tic in
            // four, which is why the revenant's shot swerves in visible steps.
            {kind: 'tracer',      sprite: 'FATB', letters: ['A', 'B'], speed: 10,                flightTics: 2, explosion: 'tracerDeath',      splashDamage: 0, impactDamage: 10, alpha: 1, additive: true,
                seek: {threshold: 16.875, turnMax: 16.875, everyTics: 4, worldClock: true}, trailEffect: 'tracerSmoke', trailEveryTics: 4,
                seeSound: 'skeleton/attack', deathSound: 'skeleton/tracex'},
            // The Icon of Sin's cube (SpawnShot): +NOCLIP, so it crosses the
            // whole map untouched and hatches on the spot it was aimed at.
            {kind: 'spawnShot',   sprite: 'BOSF', letters: ['A', 'B', 'C', 'D'], speed: 10,       flightTics: 3, explosion: null,               splashDamage: 0, impactDamage: 0,  alpha: 1, additive: false,
                hatchAtSpot: {fog: 'spawnFire', telefrag: true}, seeSound: 'brain/spit', hatchSound: 'brain/spawn'}
        ];
    }

    // Vanilla P_CheckAmmo preference chain; min carries its two strict
    // thresholds (> 2 shells for the SSG, > 40 cells for the BFG).
    weaponFallbackOrder() {
        return [
            {code: 'plasma'},
            {code: 'supershotgun', min: 3},
            {code: 'chaingun'},
            {code: 'shotgun'},
            {code: 'pistol'},
            {code: 'chainsaw'},
            {code: 'rocket'},
            {code: 'bfg', min: 41},
            {code: 'fist'}
        ];
    }

    // The Doom blue armour.
    cheatKitArmor() {
        return {points: 200, absorb: 0.5};
    }

    buildItems() {
        return {
            redKey:        new DoomItem({code: 'redKey',        name: 'Red Key',         type: 'key'}),
            blueKey:       new DoomItem({code: 'blueKey',       name: 'Blue Key',        type: 'key'}),
            yellowKey:     new DoomItem({code: 'yellowKey',     name: 'Yellow Key',      type: 'key'}),
            berserk:       new DoomItem({code: 'berserk',       name: 'Berserk',         type: 'powerupPermanent', effect: 'berserk', pickupHeal: 100, pickupWeapon: 'fist'}),
            computerMap:   new DoomItem({code: 'computerMap',   name: 'Computer Map',    type: 'powerupPermanent', effect: 'map'}),
            invulnerability: new DoomItem({code: 'invulnerability', name: 'Invulnerability', type: 'powerupTimed', effect: 'invulnerability', duration: 30000}),
            radiationSuit: new DoomItem({code: 'radiationSuit', name: 'Radiation Suit',  type: 'powerupTimed', effect: 'radiation', duration: 60000}),
            lightVisor:    new DoomItem({code: 'lightVisor',    name: 'Light Visor',     type: 'powerupTimed', effect: 'light', duration: 120000}),
            invisibility:  new DoomItem({code: 'invisibility',  name: 'Invisibility',    type: 'powerupTimed', effect: 'invisibility', duration: 60000})
        };
    }

    // Vanilla start (g_game.c G_PlayerReborn).
    startingLoadout() {
        return {
            weapons:      ['fist', 'pistol'],
            activeWeapon: 'pistol',
            ammo:         {bullets: 50},
            maxArmor:     200
        };
    }

    hudWeaponSlots() {
        return {
            count: 7,
            // Slot 1 (the fist) is always lit; the chainsaw is its upgrade.
            alwaysOwnedSlot: 1,
            upgradeWeapon:   'chainsaw',
            byWeapon: {
                fist:         1,
                chainsaw:     1,
                pistol:       2,
                shotgun:      3,
                supershotgun: 3,
                chaingun:     4,
                rocket:       5,
                plasma:       6,
                bfg:          7
            }
        };
    }

    hudKeyColors() {
        return {blueKey: '#3d7bff', yellowKey: '#ffd23d', redKey: '#ff4444'};
    }

    // Doom SNDINFO transcription (filter/game-doomchex/sndinfo.txt): logical
    // names, $random groups, $alias links and the $limit/$pitchshift overrides.
    // The player set is the 'male' table (deliberate simplification); the game-wide
    // $pitchshiftrange 4 lives in soundPitchRange, the saw block narrows to 3.
    soundDefs() {
        return {
            // Player ($playersound male)
            '*death':   {lump: 'DSPLDETH'},
            '*xdeath':  {lump: 'DSPDIEHI'},
            '*gibbed':  {lump: 'DSSLOP'},
            '*pain100': {lump: 'DSPLPAIN'},
            '*grunt':   {lump: 'DSOOF'},
            '*land':    {alias: '*grunt'},
            '*jump':    {lump: 'DSJUMP'},
            '*fist':    {lump: 'DSPUNCH'},
            '*usefail': {lump: 'DSNOWAY'},
            // Weapons
            'weapons/sawup':   {lump: 'DSSAWUP', pitch: 3},
            'weapons/sawidle': {lump: 'DSSAWIDL', pitch: 3},
            'weapons/sawfull': {lump: 'DSSAWFUL', pitch: 3},
            'weapons/sawhit':  {lump: 'DSSAWHIT', pitch: 3},
            'weapons/pistol':  {lump: 'DSPISTOL'},
            'weapons/shotgf':  {lump: 'DSSHOTGN'},
            'weapons/sshotf':  {lump: 'DSDSHTGN'},
            'weapons/sshoto':  {lump: 'DSDBOPN'},
            'weapons/sshotc':  {lump: 'DSDBCLS'},
            'weapons/sshotl':  {lump: 'DSDBLOAD'},
            'weapons/chngun':  {lump: 'DSPISTOL', limit: 0},
            'weapons/rocklx':  {lump: 'DSBAREXP', limit: 0},
            'weapons/rocklf':  {lump: 'DSRLAUNC', limit: 0},
            'weapons/plasmaf': {lump: 'DSPLASMA', limit: 0},
            'weapons/plasmax': {lump: 'DSFIRXPL'},
            'weapons/bfgf':    {lump: 'DSBFG'},
            'weapons/bfgx':    {lump: 'DSRXPLOD'},
            // Monsters
            'grunt/sight':     {random: ['grunt/sight1', 'grunt/sight2', 'grunt/sight3']},
            'grunt/death':     {random: ['grunt/death1', 'grunt/death2', 'grunt/death3']},
            'grunt/sight1':    {lump: 'DSPOSIT1'},
            'grunt/sight2':    {lump: 'DSPOSIT2'},
            'grunt/sight3':    {lump: 'DSPOSIT3'},
            'grunt/active':    {lump: 'DSPOSACT'},
            'grunt/pain':      {lump: 'DSPOPAIN'},
            'grunt/death1':    {lump: 'DSPODTH1'},
            'grunt/death2':    {lump: 'DSPODTH2'},
            'grunt/death3':    {lump: 'DSPODTH3'},
            'grunt/attack':    {lump: 'DSPISTOL'},
            'shotguy/sight':   {alias: 'grunt/sight'},
            'shotguy/active':  {lump: 'DSPOSACT'},
            'shotguy/pain':    {lump: 'DSPOPAIN'},
            'shotguy/death':   {alias: 'grunt/death'},
            'shotguy/attack':  {lump: 'DSSHOTGN'},
            'chainguy/sight':  {alias: 'grunt/sight'},
            'chainguy/active': {lump: 'DSPOSACT'},
            'chainguy/pain':   {lump: 'DSPOPAIN'},
            'chainguy/death':  {alias: 'grunt/death'},
            'chainguy/attack': {lump: 'DSSHOTGN', limit: 0},
            'imp/sight':       {random: ['imp/sight1', 'imp/sight2']},
            'imp/death':       {random: ['imp/death1', 'imp/death2']},
            'imp/sight1':      {lump: 'DSBGSIT1'},
            'imp/sight2':      {lump: 'DSBGSIT2'},
            'imp/active':      {lump: 'DSBGACT', limit: 6},
            'imp/pain':        {lump: 'DSPOPAIN'},
            'imp/melee':       {lump: 'DSCLAW'},
            'imp/death1':      {lump: 'DSBGDTH1'},
            'imp/death2':      {lump: 'DSBGDTH2'},
            'imp/attack':      {lump: 'DSFIRSHT'},
            'imp/shotx':       {lump: 'DSFIRXPL'},
            'demon/sight':     {lump: 'DSSGTSIT'},
            'demon/active':    {lump: 'DSDMACT'},
            'demon/pain':      {lump: 'DSDMPAIN'},
            'demon/melee':     {lump: 'DSSGTATK', limit: 4},
            'demon/death':     {lump: 'DSSGTDTH'},
            'caco/sight':      {lump: 'DSCACSIT'},
            'caco/active':     {lump: 'DSDMACT'},
            'caco/pain':       {lump: 'DSDMPAIN'},
            'caco/death':      {lump: 'DSCACDTH'},
            'caco/attack':     {lump: 'DSFIRSHT'},
            'caco/shotx':      {lump: 'DSFIRXPL'},
            'baron/sight':     {lump: 'DSBRSSIT'},
            'baron/active':    {lump: 'DSDMACT'},
            'baron/pain':      {lump: 'DSDMPAIN'},
            'baron/melee':     {lump: 'DSCLAW'},
            'baron/death':     {lump: 'DSBRSDTH'},
            'baron/attack':    {lump: 'DSFIRSHT'},
            'baron/shotx':     {lump: 'DSFIRXPL'},
            'knight/sight':    {lump: 'DSKNTSIT'},
            'knight/active':   {lump: 'DSDMACT'},
            'knight/pain':     {lump: 'DSDMPAIN'},
            'knight/death':    {lump: 'DSKNTDTH'},
            'skull/active':    {lump: 'DSDMACT'},
            'skull/pain':      {lump: 'DSDMPAIN'},
            'skull/melee':     {lump: 'DSSKLATK'},
            'skull/death':     {lump: 'DSFIRXPL'},
            'vile/sight':      {lump: 'DSVILSIT'},
            'vile/active':     {lump: 'DSVILACT'},
            'vile/pain':       {lump: 'DSVIPAIN'},
            'vile/death':      {lump: 'DSVILDTH'},
            'vile/raise':      {lump: 'DSSLOP'},
            'vile/start':      {lump: 'DSVILATK'},
            'vile/stop':       {lump: 'DSBAREXP'},
            'vile/firestrt':   {lump: 'DSFLAMST'},
            'vile/firecrkl':   {lump: 'DSFLAME'},
            'skeleton/sight':  {lump: 'DSSKESIT'},
            'skeleton/active': {lump: 'DSSKEACT'},
            'skeleton/pain':   {lump: 'DSPOPAIN'},
            'skeleton/melee':  {lump: 'DSSKEPCH'},
            'skeleton/swing':  {lump: 'DSSKESWG'},
            'skeleton/death':  {lump: 'DSSKEDTH'},
            'skeleton/attack': {lump: 'DSSKEATK'},
            'skeleton/tracex': {lump: 'DSBAREXP'},
            'fatso/sight':     {lump: 'DSMANSIT'},
            'fatso/active':    {lump: 'DSPOSACT'},
            'fatso/pain':      {lump: 'DSMNPAIN'},
            'fatso/raiseguns': {lump: 'DSMANATK'},
            'fatso/death':     {lump: 'DSMANDTH'},
            'fatso/attack':    {lump: 'DSFIRSHT'},
            'fatso/shotx':     {lump: 'DSFIRXPL'},
            'spider/sight':    {lump: 'DSSPISIT', limit: 4},
            'spider/active':   {lump: 'DSDMACT'},
            'spider/pain':     {lump: 'DSDMPAIN'},
            'spider/attack':   {lump: 'DSSHOTGN'},
            'spider/death':    {lump: 'DSSPIDTH', limit: 4},
            'spider/walk':     {lump: 'DSMETAL'},
            'baby/sight':      {lump: 'DSBSPSIT'},
            'baby/active':     {lump: 'DSBSPACT'},
            'baby/pain':       {lump: 'DSDMPAIN'},
            'baby/death':      {lump: 'DSBSPDTH'},
            'baby/walk':       {lump: 'DSBSPWLK'},
            'baby/attack':     {lump: 'DSPLASMA', limit: 0},
            'baby/shotx':      {lump: 'DSFIRXPL'},
            'cyber/sight':     {lump: 'DSCYBSIT', limit: 4},
            'cyber/active':    {lump: 'DSDMACT'},
            'cyber/pain':      {lump: 'DSDMPAIN'},
            'cyber/death':     {lump: 'DSCYBDTH', limit: 4},
            'cyber/hoof':      {lump: 'DSHOOF'},
            'pain/sight':      {lump: 'DSPESIT'},
            'pain/active':     {lump: 'DSDMACT'},
            'pain/pain':       {lump: 'DSPEPAIN'},
            'pain/death':      {lump: 'DSPEDTH'},
            'wolfss/sight':    {lump: 'DSSSSIT'},
            'wolfss/active':   {lump: 'DSPOSACT'},
            'wolfss/pain':     {lump: 'DSPOPAIN'},
            'wolfss/death':    {lump: 'DSSSDTH'},
            'wolfss/attack':   {lump: 'DSSHOTGN'},
            'keen/pain':       {lump: 'DSKEENPN'},
            'keen/death':      {lump: 'DSKEENDT'},
            'brain/sight':     {lump: 'DSBOSSIT'},
            'brain/pain':      {lump: 'DSBOSPN'},
            'brain/death':     {lump: 'DSBOSDTH'},
            'brain/spit':      {lump: 'DSBOSPIT'},
            'brain/spawn':     {alias: 'misc/teleport'},
            // World, movers, pickups
            'world/barrelx':     {lump: 'DSBAREXP'},
            'plats/pt1_strt':    {lump: 'DSPSTART'},
            'plats/pt1_stop':    {lump: 'DSPSTOP'},
            'plats/pt1_mid':     {lump: 'DSSTNMOV'},
            'doors/dr1_open':    {lump: 'DSDOROPN'},
            'doors/dr1_clos':    {lump: 'DSDORCLS'},
            'doors/dr2_open':    {lump: 'DSBDOPN'},
            'doors/dr2_clos':    {lump: 'DSBDCLS'},
            'switches/normbutn': {lump: 'DSSWTCHN'},
            'switches/exitbutn': {lump: 'DSSWTCHX'},
            'misc/secret':       {lump: 'DSSECRET'},
            'misc/gibbed':       {lump: 'DSSLOP'},
            'misc/w_pkup':       {lump: 'DSWPNUP'},
            'misc/p_pkup':       {lump: 'DSGETPOW'},
            'misc/i_pkup':       {lump: 'DSITEMUP', pitch: 0},
            'misc/k_pkup':       {lump: 'DSITEMUP', pitch: 0},
            'misc/teleport':     {lump: 'DSTELEPT'},
            'misc/spawn':        {lump: 'DSITMBK'}
        };
    }

    // What each monster def voices (zscript sound properties): see at wake,
    // active on the A_Chase bark roll, pain/death on their state entries,
    // melee on a landed bite, attack on a bullet volley; `actions` maps a
    // state action to its A_StartSound; `boss: true` plays see/death at full
    // volume (bBoss). Missile launches/impacts ride the projectile defs.
    monsterSounds() {
        return {
            zombieman:     {see: 'grunt/sight', active: 'grunt/active', pain: 'grunt/pain', death: 'grunt/death', attack: 'grunt/attack'},
            shotgunguy:    {see: 'shotguy/sight', active: 'shotguy/active', pain: 'shotguy/pain', death: 'shotguy/death', attack: 'shotguy/attack'},
            chaingunguy:   {see: 'chainguy/sight', active: 'chainguy/active', pain: 'chainguy/pain', death: 'chainguy/death', attack: 'chainguy/attack'},
            wolfss:        {see: 'wolfss/sight', active: 'wolfss/active', pain: 'wolfss/pain', death: 'wolfss/death', attack: 'wolfss/attack'},
            imp:           {see: 'imp/sight', active: 'imp/active', pain: 'imp/pain', death: 'imp/death', melee: 'imp/melee'},
            demon:         {see: 'demon/sight', active: 'demon/active', pain: 'demon/pain', death: 'demon/death', melee: 'demon/melee'},
            spectre:       {see: 'demon/sight', active: 'demon/active', pain: 'demon/pain', death: 'demon/death', melee: 'demon/melee'},
            lostsoul:      {active: 'skull/active', pain: 'skull/pain', death: 'skull/death', actions: {A_SkullAttack: 'skull/melee'}},
            cacodemon:     {see: 'caco/sight', active: 'caco/active', pain: 'caco/pain', death: 'caco/death'},
            hellknight:    {see: 'knight/sight', active: 'knight/active', pain: 'knight/pain', death: 'knight/death', melee: 'baron/melee'},
            baron:         {see: 'baron/sight', active: 'baron/active', pain: 'baron/pain', death: 'baron/death', melee: 'baron/melee'},
            revenant:      {see: 'skeleton/sight', active: 'skeleton/active', pain: 'skeleton/pain', death: 'skeleton/death', melee: 'skeleton/melee', actions: {A_SkelWhoosh: 'skeleton/swing'}},
            mancubus:      {see: 'fatso/sight', active: 'fatso/active', pain: 'fatso/pain', death: 'fatso/death', actions: {A_FatRaise: 'fatso/raiseguns'}},
            arachnotron:   {see: 'baby/sight', active: 'baby/active', pain: 'baby/pain', death: 'baby/death', actions: {A_BabyMetal: 'baby/walk'}},
            painelemental: {see: 'pain/sight', active: 'pain/active', pain: 'pain/pain', death: 'pain/death'},
            archvile:      {see: 'vile/sight', active: 'vile/active', pain: 'vile/pain', death: 'vile/death', actions: {A_VileStart: 'vile/start', A_VileAttack: 'vile/stop'}},
            mastermind:    {see: 'spider/sight', active: 'spider/active', pain: 'spider/pain', death: 'spider/death', attack: 'spider/attack', boss: true, actions: {A_Metal: 'spider/walk'}},
            cyberdemon:    {see: 'cyber/sight', active: 'cyber/active', pain: 'cyber/pain', death: 'cyber/death', boss: true, actions: {A_Hoof: 'cyber/hoof', A_Metal: 'spider/walk'}},
            keen:          {pain: 'keen/pain', death: 'keen/death'},
            barrel:        {death: 'world/barrelx'},
            bossbrain:     {see: 'brain/sight', pain: 'brain/pain', death: 'brain/death', boss: true},
            bosseye:       {}
        };
    }

    // Doom attenuation ($rolloff * 200 1200, base sndinfo.txt:51) and pitch
    // variation ($pitchshiftrange 4, game-doomchex/sndinfo.txt:10).
    soundRolloff() {
        return {type: 'doom', min: 200, max: 1200};
    }

    soundPitchRange() {
        return 4;
    }

    // Title and intermission songs (UZDoom mapinfo doomcommon/doom1 gameinfo):
    // the commercial lumps first, the Doom 1 ones behind — one profile serves
    // both WAD families and each carries only its own pair.
    menuMusicLumps() {
        return ['D_DM2TTL', 'D_INTRO'];
    }

    intermissionMusicLumps() {
        return ['D_DM2INT', 'D_INTER'];
    }

    finaleMusicLumps() {
        return ['D_READ_M', 'D_VICTOR'];
    }

    // Level songs: ExMy plays its own D_ExMy lump (mapinfo/doom1.txt) — but
    // the original Ultimate Doom WAD ships no E4 songs and reuses earlier
    // ones (linuxdoom s_sound.c spmus), so E4 falls back on that table when
    // the own lump is absent (Freedoom provides real E4 lumps). MAPxx plays
    // the ordered commercial list (mapinfo/doom2.txt, mus_runnin + map − 1).
    levelMusicLumps(levelCode) {
        const code = WadLevelCode.parse(levelCode);
        if (code.episode !== null) {
            const candidates = ['D_' + levelCode];
            if (code.episode === 4) {
                candidates.push(DefaultGameProfile.E4_MUSIC_REUSE[code.map - 1]);
            }
            return candidates;
        }
        if (code.number !== null) {
            const song = DefaultGameProfile.MAP_MUSIC[code.number - 1];
            return ((song !== undefined) ? ['D_' + song] : []);
        }

        return [];
    }

    // am_map.cpp DoomColors. `locked` is only the fallback of a key with no HUD
    // colour: a locked line normally takes the colour of the key it demands.
    automapColors() {
        return {
            background: [0x00, 0x00, 0x00],
            wall:       [0xfc, 0x00, 0x00],
            floorStep:  [0xbc, 0x78, 0x48],
            ceilStep:   [0xfc, 0xfc, 0x00],
            locked:     [0xfc, 0xfc, 0x00],
            notSeen:    [0x6c, 0x6c, 0x6c]
        };
    }

    // The animated walls of p_spec.c that show blood, slime, water, lava or
    // magma; flames and the boss brain keep their decals.
    liquidWallTextures() {
        return [
            'BLODGR1', 'BLODGR2', 'BLODGR3', 'BLODGR4',
            'SLADRIP1', 'SLADRIP2', 'SLADRIP3',
            'BLODRIP1', 'BLODRIP2', 'BLODRIP3', 'BLODRIP4',
            'GSTFONT1', 'GSTFONT2', 'GSTFONT3',
            'FIRELAV3', 'FIRELAVA',
            'FIREMAG1', 'FIREMAG2', 'FIREMAG3',
            'ROCKRED1', 'ROCKRED2', 'ROCKRED3',
            'BFALL1', 'BFALL2', 'BFALL3', 'BFALL4',
            'SFALL1', 'SFALL2', 'SFALL3', 'SFALL4',
            'WFALL1', 'WFALL2', 'WFALL3', 'WFALL4'
        ];
    }

    // Vanilla Doom hardcoded animation sequences (p_spec.c, 8 tics per frame),
    // used when the WAD has no ANIMATED lump.
    vanillaAnimSequences() {
        const sequences = [
            [true,  ['NUKAGE1', 'NUKAGE2', 'NUKAGE3']],
            [true,  ['FWATER1', 'FWATER2', 'FWATER3', 'FWATER4']],
            [true,  ['SWATER1', 'SWATER2', 'SWATER3', 'SWATER4']],
            [true,  ['LAVA1', 'LAVA2', 'LAVA3', 'LAVA4']],
            [true,  ['BLOOD1', 'BLOOD2', 'BLOOD3']],
            [true,  ['RROCK05', 'RROCK06', 'RROCK07', 'RROCK08']],
            [true,  ['SLIME01', 'SLIME02', 'SLIME03', 'SLIME04']],
            [true,  ['SLIME05', 'SLIME06', 'SLIME07', 'SLIME08']],
            [true,  ['SLIME09', 'SLIME10', 'SLIME11', 'SLIME12']],
            [false, ['BLODGR1', 'BLODGR2', 'BLODGR3', 'BLODGR4']],
            [false, ['SLADRIP1', 'SLADRIP2', 'SLADRIP3']],
            [false, ['BLODRIP1', 'BLODRIP2', 'BLODRIP3', 'BLODRIP4']],
            [false, ['FIREWALA', 'FIREWALB', 'FIREWALL']],
            [false, ['GSTFONT1', 'GSTFONT2', 'GSTFONT3']],
            [false, ['FIRELAV3', 'FIRELAVA']],
            [false, ['FIREMAG1', 'FIREMAG2', 'FIREMAG3']],
            [false, ['FIREBLU1', 'FIREBLU2']],
            [false, ['ROCKRED1', 'ROCKRED2', 'ROCKRED3']],
            [false, ['BFALL1', 'BFALL2', 'BFALL3', 'BFALL4']],
            [false, ['SFALL1', 'SFALL2', 'SFALL3', 'SFALL4']],
            [false, ['WFALL1', 'WFALL2', 'WFALL3', 'WFALL4']],
            [false, ['DBRAIN1', 'DBRAIN2', 'DBRAIN3', 'DBRAIN4']]
        ];

        return sequences.map((entry) => ({isFlat: entry[0], frames: entry[1], speedTics: 8}));
    }

    // The animated floors of p_spec.c are all liquids but the RROCK rock —
    // UZDoom keeps no terrain table for Doom, so this is the vanilla list.
    terrainFlats() {
        return AbstractGameProfile.terrainGroup('liquid', [
            'NUKAGE1', 'NUKAGE2', 'NUKAGE3',
            'FWATER1', 'FWATER2', 'FWATER3', 'FWATER4',
            'SWATER1', 'SWATER2', 'SWATER3', 'SWATER4',
            'LAVA1', 'LAVA2', 'LAVA3', 'LAVA4',
            'BLOOD1', 'BLOOD2', 'BLOOD3',
            'SLIME01', 'SLIME02', 'SLIME03', 'SLIME04',
            'SLIME05', 'SLIME06', 'SLIME07', 'SLIME08',
            'SLIME09', 'SLIME10', 'SLIME11', 'SLIME12'
        ]);
    }

    // A liquid that splashes nothing: the TERRAIN lump maps no Doom flat at
    // all, and no IWAD of the family carries the sprites a splash would need.
    // The entry exists only to keep the impact decals off these flats.
    terrains() {
        return {liquid: {footclip: 10}};
    }

    // Our own addition: the Doom family never sank anything, the sheet stays
    // over an untouched floor.
    liquidSurface() {
        return {mode: 'raise', alpha: 0.5, bedDarkening: 0.2};
    }

    // The Doom family and everything derived from it (Freedoom, the IWAD
    // mission packs) share the ifdoom branch of a TERRAIN lump.
    terrainGame() {
        return 'doom';
    }

    // Doom switch pairing follows the SW1xxx ↔ SW2xxx naming convention (the
    // texture bank's generic prefix substitution) — no explicit pairs needed.
    switchPairs() {
        return [];
    }

    // Vanilla sky texture by level: E<m>M<n> → SKY<m> (m clamped 1..4);
    // MAP<nn> → SKY1 (1-11) / SKY2 (12-20) / SKY3 (21+). Fallback SKY1.
    // Wrap: vanilla repeats the 256-px sky ~4× per 360°.
    skyForLevel(levelCode) {
        const wrap = 4;
        const code = WadLevelCode.parse(levelCode);
        if (code.episode !== null) {
            return {name: 'SKY' + Math.min(4, Math.max(1, code.episode)), wrap: wrap};
        }
        if (code.number !== null) {
            if (code.number <= 11) {
                return {name: 'SKY1', wrap: wrap};
            }
            if (code.number <= 20) {
                return {name: 'SKY2', wrap: wrap};
            }
            return {name: 'SKY3', wrap: wrap};
        }

        return {name: 'SKY1', wrap: wrap};
    }

    // The UZDoom impact-decal graphics (GPL v3, website/assets/uzdoom/).
    decalAssets() {
        return {
            basePath: '/assets/uzdoom/doom/sprite/',
            keys: [
                'chip1', 'chip2', 'chip3', 'chip4', 'chip5',
                'scorch1', 'plasma1', 'plasma2',
                'bfglite1', 'bfglite2', 'bfgscrc1', 'bfgscrc2'
            ]
        };
    }

    // UZDoom decaldef.txt: per-weapon graphic + scale + shade;
    // translucency + a luminance gain lifting the soft burns above the
    // shader's a<0.5 cutout (chips are already crisp). shade 'bfg' resolves
    // to bfgDecalShade() (green id art, bluish freedoom art).
    decalTemplates() {
        return [
            {type: 'bulletChip', keys: ['chip1', 'chip2', 'chip3', 'chip4', 'chip5'], scale: 0.5, shade: [0, 0, 0], translucent: 0.85, gain: 1.0},
            {type: 'scorch',     keys: ['scorch1'],              scale: 0.5, shade: [0, 0, 0], translucent: 1, gain: 1.8},
            {type: 'plasma',     keys: ['plasma1', 'plasma2'],   scale: 0.3, shade: [0, 0, 0], translucent: 1, gain: 2.2},
            {type: 'bfgscrc',    keys: ['bfgscrc1', 'bfgscrc2'], scale: 1.0, shade: [0, 0, 0], translucent: 1, gain: 2.2},
            {type: 'bfglite',    keys: ['bfglite1', 'bfglite2'], scale: 1.0, shade: 'bfg', gain: 1.5, fade: true}
        ];
    }
}

class AbstractMoverBuilder {
    /**
     * @param {object}            level
     * @param {object}            analysis
     * @param {WadTextureBank}    bank
     * @param {WadAnimationBank}  animBank
     * @param {WadLiquidSurfaces} liquids - the physical floor offsets of the liquid sectors
     */
    constructor(level, analysis, bank, animBank, liquids) {
        this._level    = level;
        this._analysis = analysis;
        this._bank     = bank;
        this._animBank = animBank;
        this._liquids  = liquids;
    }

    /**
     * One built mover per sector, in ascending sector order — the instance
     * codes are part of the save format (a rebuilt level must name them the
     * same way), so the order may not depend on a Set's iteration.
     *
     * @returns {object[]} [{code, textures (bank indices), mesh, instanceData}]
     */
    buildAll() {
        const movers = [];
        for (const si of [...this._sectorIds()].sort((a, b) => (a - b))) {
            const built = this._buildOne(si);
            if (built !== null) {
                movers.push(built);
            }
        }

        return movers;
    }

    /**
     * Texture list of a finished mesh: the global bank indices are remapped to
     * the instance's own list and the animation groups are applied in place.
     * null when the geometry came out empty — the sector then has no mover at
     * all (a lift with nowhere to go, a step whose neighbour owns every riser).
     *
     * @returns {int[]|null}
     */
    _meshTextures(mesh) {
        if (mesh.points.length === 0) {
            return null;
        }
        const groups = this._animBank.buildAnimGroups(WadMeshBuilder.remapLocalTextures(mesh.faces));
        WadMeshBuilder.applyAnimMap(mesh.faces, groups.animMap);

        return groups.newList;
    }

    // Riser (riserBaseFh → origFh) on EVERY two-sided edge: the mover is a
    // self-contained box, so two adjacent movers at different heights keep a
    // wall between them. One-sided edges belong to the static map. Vanilla
    // anchors a lower-unpegged texture to the ceiling, hence the uvAnchor.
    _buildRisers(mesh, si, origFh, riserBaseFh, moverCode) {
        const {vertexes, linedefs, sidedefs, sectors} = this._level;
        const SCALE = WadConstants.SCALE;

        const usableLower = (sd) => {
            if (!sd || WadTextureBank.isBlank(sd.lower)) {
                return null;
            }
            return ((this._bank.ensureWallTex(sd.lower) >= 0) ? sd.lower : null);
        };

        const edges = [];
        let fallbackTex = null;

        for (const ld of linedefs) {
            if ((ld.right < 0) || (ld.left < 0)) {
                continue;
            }
            const rightSi      = sidedefs[ld.right].sector;
            const leftSi       = sidedefs[ld.left].sector;
            const moverOnRight = (rightSi === si);
            const moverOnLeft  = (leftSi === si);
            if (!moverOnRight && !moverOnLeft) {
                continue;
            }

            const ownSd        = sidedefs[((moverOnRight) ? ld.right : ld.left)];
            const neighbourSd  = sidedefs[((moverOnRight) ? ld.left : ld.right)];
            const neighbourSec = sectors[((moverOnRight) ? leftSi : rightSi)];

            let tex    = usableLower(neighbourSd);
            let srcSd  = neighbourSd;
            let srcSec = neighbourSec;
            let srcSi  = ((moverOnRight) ? leftSi : rightSi);
            if (tex === null) {
                tex    = usableLower(ownSd);
                srcSd  = ownSd;
                srcSec = sectors[si];
                srcSi  = si;
            }
            if ((tex !== null) && (fallbackTex === null)) {
                fallbackTex = tex;
            }

            const [dx1, dy1] = vertexes[ld.v1];
            const [dx2, dy2] = vertexes[ld.v2];
            const [wx1, wz1] = WadGeometry.doomToWorld(dx1, dy1);
            const [wx2, wz2] = WadGeometry.doomToWorld(dx2, dy2);
            edges.push({
                ld, tex, srcSd, srcSec, srcSi,
                wx1, wz1, wx2, wz2,
                wallLen: WadGeometry.wallLengthDoom(vertexes, ld.v1, ld.v2),
                flip: !moverOnRight
            });
        }

        for (const e of edges) {
            const tex = ((e.tex !== null) ? e.tex : fallbackTex);
            if (tex === null) {
                continue;
            }
            const ti = this._bank.ensureWallTex(tex);
            if (ti < 0) {
                continue;
            }
            const {width: tw, height: th} = this._bank.getDims(ti);
            const uv = WadMeshBuilder.moverRiserUv(e.ld, e.srcSd, e.srcSec, origFh, moverCode, th);
            WadMeshBuilder.addWallQuad(mesh, ti,
                e.wx1, e.wz1, e.wx2, e.wz2,
                riserBaseFh * SCALE, origFh * SCALE,
                e.wallLen, tw, th,
                {xOff: e.srcSd.xo, yOff: uv.yOff, flip: e.flip, light: e.srcSec.light, lightGroup: WadMapAnalyzer.lightGroupOf(this._analysis, e.srcSi),
                    uvAnchor: uv.uvAnchor});
        }
    }

    /**
     * Sector ids this builder turns into movers (from the analysis).
     *
     * @returns {Set<int>}
     */
    _sectorIds() {
        throw new Error('AbstractMoverBuilder: _sectorIds not implemented');
    }

    /**
     * One mover, or null when this sector yields none.
     *
     * @returns {object|null}
     */
    _buildOne(si) {
        throw new Error('AbstractMoverBuilder: _buildOne not implemented');
    }
}

// Part 2: the placeholder bindings. Every other file declares its classes in
// its own scope, so nothing is hoisted here — the bootstrap runs the whole js
// list strictly in manifest order (parallel fetch, ordered insertion), which
// guarantees a base class exists before any file extends it. The prelude only
// carries the bases that used to crash when batches raced each other; those
// five files are out of the manifest now, so nothing redeclares them.

// Static data tables — mirrored from their source files so subclasses and
// consumers can read them right after the prelude ran, even when the
// defining file lands in a later batch. Plain property assignments are
// idempotent, so the original files re-running them changes nothing.
AbstractGameProfile._playerBodies = new Map();   // body data → its DoomMonsterDef
DefaultGameProfile.BRAIN_SCREAM = ['A_BrainScream', {
    effect:    'brainExplosion',
    fromX:     -196,
    toX:       320,
    stepX:     8,
    aheadY:    -320,
    liftMax:   512,
    startJitterTics: 8
}];

// SpawnFly (bossbrain.zs): the probability ladder of a boss cube, decreasing
// likelihood. `below` is the exclusive upper bound of the 0..255 roll, so an
// entry weighs (its bound − the previous one) out of 256.
DefaultGameProfile.BOSS_CUBE_SPAWNS = [
    {below: 50,  kind: 'imp'},
    {below: 90,  kind: 'demon'},
    {below: 120, kind: 'spectre'},
    {below: 130, kind: 'painelemental'},
    {below: 160, kind: 'cacodemon'},
    {below: 162, kind: 'archvile'},
    {below: 172, kind: 'revenant'},
    {below: 192, kind: 'arachnotron'},
    {below: 222, kind: 'mancubus'},
    {below: 246, kind: 'hellknight'},
    {below: 256, kind: 'baron'}
];

// A_PosAttack / A_SPosAttack / A_CPosAttack all fire the same 3 × (1..5)
// bullet, and every hitscan monster of the bestiary uses one of them.
DefaultGameProfile.MONSTER_BULLET = {damage: {base: 3, dice: 5}, puff: 'puff'};
// Player.ColorRange 112-127, then Player.Colorset 0-3 of doomplayer.zs: first index and marker of
// each (its last follows from the range's length).
DefaultGameProfile.PLAYER_COLORS = {
    range: [0x70, 0x7F],
    slots: [
        {from: 0x70, marker: 0x72},
        {from: 0x60, marker: 0x62},
        {from: 0x40, marker: 0x42},
        {from: 0x20, marker: 0x22}
    ]
};
// zscript doomplayer.zs.
DefaultGameProfile.PLAYER_BODY = {
    code: 'player', name: 'Marine', sprite: 'PLAY',
    health: 100, radius: 16, height: 56, speed: 1, painChance: 255,
    states: {
        spawn:   [['A', -1]],
        see:     [['ABCD', 4, null, 'see']],
        missile: [['E', 12, null, 'spawn']],
        melee:   [['F', 6, null, 'missile', true]],
        pain:    [['G', 4], ['G', 4, 'A_Pain', 'spawn']],
        death:   [['H', 10], ['I', 10, 'A_PlayerScream'], ['J', 10, 'A_NoBlocking'], ['KLM', 10], ['N', -1]],
        xdeath:  [['O', 5], ['P', 5, 'A_XScream'], ['Q', 5, 'A_NoBlocking'], ['RSTUV', 5], ['W', -1]]
    }
};
// P_GiveWeapon gives 5 clips for a placed weapon in deathmatch, 2 otherwise.
DefaultGameProfile.MULTIPLAYER_ITEM_RULES = {weaponsStay: true, keysStay: true, deathmatchWeaponClips: 5};
DefaultGameProfile.ITEM_RESPAWN_RULES     = {delayTics: 1050, revealTics: 0, effect: 'itemFog', sound: 'misc/spawn', neverTypes: [2022, 2024]};

// Commercial level songs in map order (mapinfo/doom2.txt, the vanilla
// mus_runnin + map − 1 sequence): lump = 'D_' + name.
DefaultGameProfile.MAP_MUSIC = [
    'RUNNIN', 'STALKS', 'COUNTD', 'BETWEE', 'DOOM',   'THE_DA', 'SHAWN',  'DDTBLU',
    'IN_CIT', 'DEAD',   'STLKS2', 'THEDA2', 'DOOM2',  'DDTBL2', 'RUNNI2', 'DEAD2',
    'STLKS3', 'ROMERO', 'SHAWN2', 'MESSAG', 'COUNT2', 'DDTBL3', 'AMPIE',  'THEDA3',
    'ADRIAN', 'MESSG2', 'ROMER2', 'TENSE',  'SHAWN3', 'OPENIN', 'EVIL',   'ULTIMA'
];

// Ultimate Doom's fourth episode reuses earlier songs (linuxdoom s_sound.c
// spmus table, E4M1..E4M9) — its WAD ships no D_E4M* lump.
DefaultGameProfile.E4_MUSIC_REUSE = [
    'D_E3M4', 'D_E3M2', 'D_E3M3', 'D_E1M5', 'D_E2M7', 'D_E2M4', 'D_E2M6', 'D_E2M5', 'D_E1M9'
];
