// Procedural texture helpers: float height fields, height → normal / roughness / tint maps, canvas textures,
// world-unit UVs. Everything is generated once at setup (in sceneReady) on the CPU, edge ≤ 1024 px, and cached by key.
// 程序化贴图工具：高度场、高度 → 法线 / 粗糙度 / 色彩贴图、画布贴图、世界单位 UV。都在 sceneReady 里一次生成，边长 ≤ 1024，按 key 缓存。
import * as THREE from 'three';

/** 贴图边长上限 / texture edge limit. */
export const MAX_TEXTURE_SIZE = 1024;

const cache = new Map();
/**
 * 按 key 缓存一次性生成的结果（贴图、高度场）/ memoise an expensive generator by key.
 * @template T
 * @param {string} key
 * @param {() => T} make
 * @returns {T}
 */
export function cached( key, make ) {

	if ( ! cache.has( key ) ) cache.set( key, make() );
	return cache.get( key );

}

/** 把边长限制到 [16, 1024] 的 2 的幂 / clamp a texture edge to a power of two in [16, 1024]. */
export const texSize = ( n = 512 ) => Math.min( MAX_TEXTURE_SIZE, Math.max( 16, 2 ** Math.round( Math.log2( n ) ) ) );

/** 新建画布 / new canvas (DOM canvas so CanvasTexture can upload it). */
export function makeCanvas( w, h = w ) {

	const c = document.createElement( 'canvas' );
	c.width = w; c.height = h;
	return c;

}

/**
 * 浮点高度场 / float height field.
 * @param {number} w 宽 / width
 * @param {number} h 高 / height
 * @param {(u:number,v:number,x:number,y:number)=>number} fn u,v ∈ [0,1)（画布坐标，v 向下）/ canvas coords, v down
 * @returns {{data:Float32Array,width:number,height:number}}
 */
export function heightField( w, h, fn ) {

	const data = new Float32Array( w * h );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) data[ y * w + x ] = fn( x / w, y / h, x, y );
	return { data, width: w, height: h };

}

/** 把画布的红色通道读成高度场 [0,1] / read a canvas' red channel as a height field. */
export function canvasToHeight( canvas ) {

	const w = canvas.width, h = canvas.height;
	const src = canvas.getContext( '2d' ).getImageData( 0, 0, w, h ).data;
	const data = new Float32Array( w * h );
	for ( let i = 0; i < w * h; i ++ ) data[ i ] = src[ i * 4 ] / 255;
	return { data, width: w, height: h };

}

/** 高度场归一化到 [0,1]（原地）/ normalise a height field to [0,1] in place. */
export function normalizeField( f ) {

	let lo = Infinity, hi = - Infinity;
	for ( const v of f.data ) {

		if ( v < lo ) lo = v;
		if ( v > hi ) hi = v;

	}

	const k = hi > lo ? 1 / ( hi - lo ) : 0;
	for ( let i = 0; i < f.data.length; i ++ ) f.data[ i ] = ( f.data[ i ] - lo ) * k;
	return f;

}

/**
 * 盒式模糊（可环绕，做 passes 次近似高斯）/ separable box blur (wrapping), repeated to approximate a gaussian.
 * @param {{data:Float32Array,width:number,height:number}} f
 * @param {number} radius 像素 / pixels
 * @param {{wrap?:boolean, passes?:number}} [o]
 * @returns 新高度场 / a new field
 */
export function blurField( f, radius = 1, o = {} ) {

	const { width: w, height: h } = f, wrap = o.wrap ?? true, r = Math.max( 1, Math.round( radius ) );
	let a = Float32Array.from( f.data ), b = new Float32Array( w * h );
	const idx = ( i, n ) => ( wrap ? ( ( i % n ) + n ) % n : Math.min( n - 1, Math.max( 0, i ) ) );
	for ( let pass = 0; pass < ( o.passes ?? 2 ); pass ++ ) {

		for ( let y = 0; y < h; y ++ ) {

			let s = 0;
			for ( let k = - r; k <= r; k ++ ) s += a[ y * w + idx( k, w ) ];
			for ( let x = 0; x < w; x ++ ) {

				b[ y * w + x ] = s / ( 2 * r + 1 );
				s += a[ y * w + idx( x + r + 1, w ) ] - a[ y * w + idx( x - r, w ) ];

			}

		}

		for ( let x = 0; x < w; x ++ ) {

			let s = 0;
			for ( let k = - r; k <= r; k ++ ) s += b[ idx( k, h ) * w + x ];
			for ( let y = 0; y < h; y ++ ) {

				a[ y * w + x ] = s / ( 2 * r + 1 );
				s += b[ idx( y + r + 1, h ) * w + x ] - b[ idx( y - r, h ) * w + x ];

			}

		}

	}

	return { data: a, width: w, height: h };

}

/**
 * 高度图 → 切线空间法线贴图（OpenGL 约定，配合 three.js 默认 flipY）。
 * Height map → tangent-space normal map (OpenGL convention, for three.js' default flipY).
 * 高度场的高 = 凸起。strength 是“像素梯度 × 倍数”：128² 小图用 1–3，512² 用 3–8，1024² 用 6–16（同样的起伏，分辨率越高梯度越小）。
 * Higher = raised. strength multiplies the per-pixel gradient: about 1–3 at 128², 3–8 at 512², 6–16 at 1024².
 * @param {HTMLCanvasElement|{data:Float32Array,width:number,height:number}} source 画布（取红色通道）或浮点高度场
 *   / a canvas (red channel) or a float height field
 * @param {{strength?:number, wrap?:boolean, slopes?:{x:Float32Array,y:Float32Array}, repeat?:boolean}} [o]
 *   strength 凹凸强度（默认 2）；wrap 边缘环绕（默认 true，可平铺贴图用）；slopes 额外叠加的逐像素斜率（如锡箔的平面碎片）
 *   / strength (default 2); wrap: tileable edges (default true); slopes: extra per-pixel slopes (e.g. crinkled foil facets)
 * @returns {THREE.CanvasTexture} RepeatWrapping，线性色彩空间 / RepeatWrapping, non-colour data
 */
export function heightToNormalMap( source, o = {} ) {

	const f = source instanceof HTMLCanvasElement ? canvasToHeight( source ) : source;
	return dataTexture( normalCanvasFromHeight( f, o ), { repeat: o.repeat ?? true } );

}

/** 旧名，同 heightToNormalMap / alias of heightToNormalMap. */
export const makeNormalMapFromHeight = heightToNormalMap;

/** 同 heightToNormalMap，但返回画布（便于再加工）/ same as heightToNormalMap but returns the canvas. */
export function normalCanvasFromHeight( f, o = {} ) {

	const { data: H, width: w, height: h } = f;
	const s = o.strength ?? 2, wrap = o.wrap ?? true;
	const c = makeCanvas( w, h ), g = c.getContext( '2d' ), img = g.createImageData( w, h ), d = img.data;
	const at = ( x, y ) => {

		if ( wrap ) {

			x = ( x + w ) % w; y = ( y + h ) % h;

		} else {

			x = Math.min( w - 1, Math.max( 0, x ) ); y = Math.min( h - 1, Math.max( 0, y ) );

		}

		return H[ y * w + x ];

	};

	const sx = o.slopes?.x, sy = o.slopes?.y;
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const i = y * w + x;
		let dx = ( at( x + 1, y ) - at( x - 1, y ) ) * s, dy = ( at( x, y + 1 ) - at( x, y - 1 ) ) * s;
		if ( sx ) {

			dx += sx[ i ]; dy += sy[ i ];

		}

		const l = Math.hypot( dx, dy, 1 ), j = i * 4;
		d[ j ] = ( - dx / l * 0.5 + 0.5 ) * 255;
		d[ j + 1 ] = ( dy / l * 0.5 + 0.5 ) * 255;
		d[ j + 2 ] = ( 1 / l * 0.5 + 0.5 ) * 255;
		d[ j + 3 ] = 255;

	}

	g.putImageData( img, 0, 0 );
	return c;

}

/**
 * 打包细节贴图（一张 RGBA，三平面投影只需 3 次采样）：R,G = 切线空间法线 x,y；B = 粗糙度；A = 明暗乘数（线性）。
 * Packed detail texture (one RGBA, so triplanar projection costs 3 fetches for everything): R,G = tangent-space normal
 * x,y; B = roughness; A = linear brightness multiplier. Used by triplanarDetail({ packed }).
 * @param {{data:Float32Array,width:number,height:number}} f 归一化高度场 / normalised height field
 * @param {{strength?:number, roughness?:(h:number)=>number, tint?:(h:number)=>number, slopes?:{x:Float32Array,y:Float32Array}}} [o]
 * @returns {THREE.DataTexture} RepeatWrapping、mipmap、线性 / repeating, mipmapped, linear
 */
export function packDetailTexture( f, o = {} ) {

	const { data: H, width: w, height: h } = f, s = o.strength ?? 2;
	const rough = o.roughness ?? ( ( v ) => 0.7 - 0.2 * ( v - 0.5 ) ), tint = o.tint ?? ( () => 1 );
	const out = new Uint8Array( w * h * 4 );
	const at = ( x, y ) => H[ ( ( y + h ) % h ) * w + ( ( x + w ) % w ) ];
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const i = y * w + x;
		let dx = ( at( x + 1, y ) - at( x - 1, y ) ) * s, dy = ( at( x, y + 1 ) - at( x, y - 1 ) ) * s;
		if ( o.slopes ) {

			dx += o.slopes.x[ i ]; dy += o.slopes.y[ i ];

		}

		const l = Math.hypot( dx, dy, 1 );
		// DataTexture rows run bottom-up (no flipY): store +v as "up" like a canvas normal map with flipY.
		const j = ( ( h - 1 - y ) * w + x ) * 4;
		out[ j ] = ( - dx / l * 0.5 + 0.5 ) * 255;
		out[ j + 1 ] = ( dy / l * 0.5 + 0.5 ) * 255;
		out[ j + 2 ] = Math.max( 0, Math.min( 1, rough( H[ i ] ) ) ) * 255;
		out[ j + 3 ] = Math.max( 0, Math.min( 1, tint( H[ i ] ) ) ) * 255;

	}

	const t = new THREE.DataTexture( out, w, h, THREE.RGBAFormat );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.generateMipmaps = true;
	t.minFilter = THREE.LinearMipmapNearestFilter;
	t.magFilter = THREE.LinearFilter;
	t.colorSpace = THREE.NoColorSpace;
	t.needsUpdate = true;
	return t;

}

/**
 * 高度场 → 灰度数据贴图（粗糙度、金属度、AO、alpha 等，写入 RGB 三个通道）。
 * Height field → greyscale data texture (roughness / metalness / AO / alpha: written to R, G and B).
 * @param {{data:Float32Array,width:number,height:number}} f
 * @param {(h:number,i:number)=>number} [fn] 高度 → 值 [0,1]（默认原值）/ height → value in [0,1]
 * @param {{repeat?:boolean}} [o]
 * @returns {THREE.CanvasTexture}
 */
export function fieldToDataTexture( f, fn = ( h ) => h, o = {} ) {

	const c = paintCanvas( f.width, f.height, ( x, y, i, out ) => {

		const v = Math.max( 0, Math.min( 255, fn( f.data[ i ], i ) * 255 ) );
		out[ 0 ] = out[ 1 ] = out[ 2 ] = v;

	} );
	return dataTexture( c, o );

}

/**
 * 粗糙度贴图：高度越低（缝里、坑里）越粗糙（invert 时相反）。three 读 G 通道并乘以 material.roughness，所以材质 roughness 设 1。
 * Roughness map from height: lower = rougher (or the reverse with invert). three reads G and multiplies material.roughness: set that to 1.
 * @param {{data:Float32Array,width:number,height:number}} f 归一化高度场 [0,1] / normalised height field
 * @param {{base?:number, range?:number, invert?:boolean, noise?:Float32Array}} [o] base 平均粗糙度（默认 0.7）；range 变化幅度（默认 0.25）
 * @returns {THREE.CanvasTexture}
 */
export function roughnessFromHeight( f, o = {} ) {

	const base = o.base ?? 0.7, range = o.range ?? 0.25, sign = o.invert ? 1 : - 1;
	return fieldToDataTexture( f, ( h, i ) => base + sign * range * ( h - 0.5 ) * 2 + ( o.noise ? o.noise[ i ] : 0 ) );

}

/**
 * 高度场 → 色彩贴图：在 low/high 两色之间按高度插值，并按 cavity 让低处变暗（sRGB）。
 * Height field → colour map: lerp low→high by height and darken low areas by `cavity` (sRGB).
 * 默认白色系：当作乘到材质 color 上的明暗/色斑贴图使用。/ Defaults to white-ish: a multiplier on material.color.
 * @param {{data:Float32Array,width:number,height:number}} f 归一化高度场 / normalised field
 * @param {{low?:THREE.ColorRepresentation, high?:THREE.ColorRepresentation, cavity?:number, gamma?:number, repeat?:boolean}} [o]
 * @returns {THREE.CanvasTexture}
 */
export function tintFromHeight( f, o = {} ) {

	const lo = new THREE.Color( o.low ?? 0xd8d8d8 ), hi = new THREE.Color( o.high ?? 0xffffff ), cav = o.cavity ?? 0.35, gm = o.gamma ?? 1;
	const tmp = new THREE.Color();
	const c = paintCanvas( f.width, f.height, ( x, y, i, out ) => {

		const h = Math.pow( Math.max( 0, Math.min( 1, f.data[ i ] ) ), gm );
		tmp.copy( lo ).lerp( hi, h ).multiplyScalar( 1 - cav * ( 1 - h ) * ( 1 - h ) );
		tmp.convertLinearToSRGB();
		out[ 0 ] = tmp.r * 255; out[ 1 ] = tmp.g * 255; out[ 2 ] = tmp.b * 255;

	} );
	return colorTexture( c, { repeat: o.repeat ?? true } );

}

/**
 * 灰度/多通道数据 → 画布 / write per-pixel RGB(A) into a canvas.
 * @param {number} w @param {number} h
 * @param {(x:number,y:number,i:number,out:number[])=>void} fn 写 out[0..3]（0..255）
 */
export function paintCanvas( w, h, fn ) {

	const c = makeCanvas( w, h ), g = c.getContext( '2d' ), img = g.createImageData( w, h ), d = img.data;
	const out = [ 0, 0, 0, 255 ];
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		out[ 3 ] = 255;
		const i = y * w + x;
		fn( x, y, i, out );
		d[ i * 4 ] = out[ 0 ]; d[ i * 4 + 1 ] = out[ 1 ]; d[ i * 4 + 2 ] = out[ 2 ]; d[ i * 4 + 3 ] = out[ 3 ];

	}

	g.putImageData( img, 0, 0 );
	return c;

}

/** 颜色贴图（sRGB）/ colour texture (sRGB). o.repeat=false 时不平铺；o.anisotropy 默认 1（软件渲染下各向异性很贵）。 */
export function colorTexture( canvas, o = {} ) {

	const t = new THREE.CanvasTexture( canvas );
	t.colorSpace = THREE.SRGBColorSpace;
	setup( t, o );
	return t;

}

/**
 * 数据贴图（法线、粗糙度等，非颜色）/ data texture (normal, roughness...: not colour).
 * 默认只取最近一级 mipmap 再双线性（LinearMipmapNearest）：细节贴图看不出区别，软件渲染下每次采样少读一半纹素。
 * Defaults to LinearMipmapNearest (bilinear within the nearest mip): indistinguishable for detail maps, half the texel
 * reads per fetch in software rendering. o.trilinear = true for full trilinear filtering.
 */
export function dataTexture( canvas, o = {} ) {

	const t = new THREE.CanvasTexture( canvas );
	t.colorSpace = THREE.NoColorSpace;
	setup( t, o );
	if ( ! o.trilinear ) t.minFilter = THREE.LinearMipmapNearestFilter;
	return t;

}

function setup( t, o ) {

	if ( o.repeat !== false ) t.wrapS = t.wrapT = THREE.RepeatWrapping;
	// Anisotropic filtering is expensive in SwiftShader (2–3× the cost of a triplanar material at 4×): off by default.
	t.anisotropy = o.anisotropy ?? 1;
	t.generateMipmaps = true;
	t.minFilter = THREE.LinearMipmapLinearFilter;

}

/**
 * 复制贴图并设置平铺次数（共享同一份图像，不会重复上传）/ clone a texture with its own repeat (shares the image upload).
 * @param {THREE.Texture} tex
 * @param {number|number[]} [repeat=1] 次数或 [u,v] / count or [u,v]
 */
export function withRepeat( tex, repeat = 1 ) {

	const t = tex.clone();
	const r = Array.isArray( repeat ) ? repeat : [ repeat, repeat ];
	t.repeat.set( r[ 0 ], r[ 1 ] );
	t.needsUpdate = false;
	return t;

}

/**
 * 盒式投影 UV：按每个面的主法线方向，用世界单位 / tile 生成 UV，贴图在各面密度一致。
 * Box-projected UVs in world units / tile, so a tiling texture has the same density on every face.
 * 适合盒子、圆角盒、拉伸体、置换后的几何体；材质预设的 repeat 就成了“每世界单位多少次”。
 * Good for boxes, extrusions and displaced meshes; a material preset's `repeat` then means "tiles per world unit".
 * @param {THREE.BufferGeometry} geometry 需有 normal 属性 / needs normals
 * @param {number} tile 一次平铺对应的世界尺寸 / world size of one texture repeat
 */
export function boxProjectUVs( geometry, tile = 1 ) {

	if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
	const p = geometry.attributes.position, n = geometry.attributes.normal;
	const uv = new Float32Array( p.count * 2 );
	for ( let i = 0; i < p.count; i ++ ) {

		const ax = Math.abs( n.getX( i ) ), ay = Math.abs( n.getY( i ) ), az = Math.abs( n.getZ( i ) );
		let u, v;
		if ( ax >= ay && ax >= az ) {

			u = - p.getZ( i ) * Math.sign( n.getX( i ) ); v = p.getY( i );

		} else if ( ay >= az ) {

			u = p.getX( i ); v = - p.getZ( i ) * Math.sign( n.getY( i ) );

		} else {

			u = p.getX( i ) * Math.sign( n.getZ( i ) ); v = p.getY( i );

		}

		uv[ i * 2 ] = u / tile; uv[ i * 2 + 1 ] = v / tile;

	}

	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
	return geometry;

}

/** 同 boxProjectUVs / alias of boxProjectUVs. */
export const worldUVs = boxProjectUVs;
