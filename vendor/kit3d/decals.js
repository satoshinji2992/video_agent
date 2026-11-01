// Decals and labels: crisp canvas textures with text (Noto Sans CJK, so Chinese works offline), rating-plate fine
// print, barcodes and hazard stripes, plus meshes that sit on flat or cylindrical surfaces without z-fighting.
// Sizing for 480p: text must be at least ~10 px tall on screen to read; draw the canvas at 4× its on-screen size
// (the frame is supersampled 2× and mipmapped), so a label 120 px wide on screen wants a 512 px canvas.
// 贴花与标签：画布贴图写字（Noto Sans CJK，离线可写中文）、铭牌小字、条码、警示斜纹；以及贴在平面/圆柱面上不闪烁的网格。
// 480p 尺寸：屏幕上字高至少约 10 像素才看得清；画布按屏幕尺寸的 4 倍画（画面 2× 超采样 + mipmap），屏幕上 120 像素宽的标签用 512 像素画布。
import * as THREE from 'three';
import { makeCanvas, colorTexture } from './textures.js';
import { makeRng } from './noise.js';

const FONT = '"Noto Sans CJK SC", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif';

/** 等字体可用（sceneReady 里在画标签前调用一次）/ wait for the label font (call once in sceneReady before drawing labels). */
export async function fontsReady( weights = [ 400, 700 ] ) {

	await Promise.all( weights.map( ( w ) => document.fonts.load( `${w} 32px "Noto Sans CJK SC"`, '中文Aa0' ).catch( () => null ) ) );
	await document.fonts.ready;

}

/**
 * 标签/铭牌/贴纸画布贴图 / label, rating plate or sticker as a canvas texture.
 * 自上而下排版：lines 各行文字；fine 若干行“小字”（灰色细条，像铭牌上的规格小字，远看是细节，近看不暴露乱码）；barcode 条码；stripes 警示斜纹边。
 * Laid out top to bottom: text lines; `fine` rows of greeked small print (reads as spec text at a distance without
 * fake words); a barcode; hazard stripes along the edge.
 * @param {object} o
 * @param {number} [o.width=512] @param {number} [o.height=256] 画布像素（≤1024）/ canvas pixels
 * @param {string} [o.background='#f2f2ee'] 底色（'transparent' 透明）/ background
 * @param {string} [o.color='#1a1a1a'] 默认文字色 / default ink
 * @param {number} [o.radius=16] 圆角（像素）/ corner radius (px)
 * @param {{color?:string, width?:number}} [o.border] 边框 / border
 * @param {number} [o.padding=28]
 * @param {{text:string, size?:number, weight?:number, color?:string, align?:'left'|'center'|'right', font?:string, spacing?:number}[]} [o.lines]
 *   size 字号（像素，默认 48）；spacing 字间距（像素）
 * @param {number} [o.fine=0] 小字行数 / rows of small print
 * @param {boolean} [o.barcode=false] 底部条码 / barcode at the bottom
 * @param {string} [o.stripes] 警示斜纹颜色（如 '#f2c200'），画在顶部条带 / hazard stripe colour (top band)
 * @param {number} [o.seed=1]
 * @param {number} [o.anisotropy=2] 斜看时更清晰，但软件渲染下每级都加开销 / sharper at grazing angles, costs per level in software rendering
 * @returns {Promise<THREE.CanvasTexture>} sRGB、不平铺 / sRGB, clamped
 */
export async function labelTexture( o = {} ) {

	await fontsReady();
	const W = Math.min( 1024, o.width ?? 512 ), H = Math.min( 1024, o.height ?? 256 ), pad = o.padding ?? 28;
	const c = makeCanvas( W, H ), g = c.getContext( '2d' ), rng = makeRng( o.seed ?? 1 );
	const r = o.radius ?? 16;
	if ( o.background !== 'transparent' ) {

		g.fillStyle = o.background ?? '#f2f2ee';
		g.beginPath(); g.roundRect( 0, 0, W, H, r ); g.fill();

	}

	let y = pad;
	if ( o.stripes ) {

		const sh = Math.round( H * 0.14 );
		g.save(); g.beginPath(); g.roundRect( 0, 0, W, sh, [ r, r, 0, 0 ] ); g.clip();
		g.fillStyle = '#151515'; g.fillRect( 0, 0, W, sh );
		g.fillStyle = o.stripes;
		for ( let x = - sh; x < W + sh; x += sh ) {

			g.beginPath(); g.moveTo( x, sh ); g.lineTo( x + sh * 0.5, 0 ); g.lineTo( x + sh, 0 ); g.lineTo( x + sh * 0.5, sh ); g.fill();

		}

		g.restore();
		y = sh + pad * 0.6;

	}

	g.textBaseline = 'top';
	for ( const L of o.lines ?? [] ) {

		const size = L.size ?? 48;
		g.font = `${L.weight ?? 700} ${size}px ${L.font ?? FONT}`;
		g.fillStyle = L.color ?? o.color ?? '#1a1a1a';
		g.textAlign = L.align ?? 'left';
		if ( 'letterSpacing' in g ) g.letterSpacing = `${L.spacing ?? 0}px`;
		const x = g.textAlign === 'center' ? W / 2 : g.textAlign === 'right' ? W - pad : pad;
		g.fillText( L.text, x, y, W - 2 * pad );
		y += size * 1.22;

	}

	g.textAlign = 'left';
	if ( 'letterSpacing' in g ) g.letterSpacing = '0px';
	const fineH = Math.max( 6, Math.round( H * 0.035 ) );
	for ( let k = 0; k < ( o.fine ?? 0 ); k ++ ) {

		// Greeked small print: words as short rounded bars.
		g.fillStyle = 'rgba(30,30,30,0.55)';
		let x = pad;
		const end = W - pad - rng.range( 0, W * 0.3 );
		while ( x < end ) {

			const w = rng.range( fineH * 0.8, fineH * 4 );
			g.beginPath(); g.roundRect( x, y, Math.min( w, end - x ), fineH * 0.7, fineH * 0.2 ); g.fill();
			x += w + fineH * 0.6;

		}

		y += fineH * 1.6;

	}

	if ( o.barcode ) {

		const bh = Math.max( 16, H - y - pad );
		let x = pad;
		g.fillStyle = '#111';
		while ( x < W * 0.55 ) {

			const w = rng.pick( [ 1.5, 1.5, 3, 4.5 ] ) * ( W / 512 );
			if ( rng.next() < 0.55 ) g.fillRect( x, y, w, bh );
			x += w;

		}

	}

	if ( o.border ) {

		g.strokeStyle = o.border.color ?? '#333'; g.lineWidth = o.border.width ?? 4;
		const b = g.lineWidth / 2;
		g.beginPath(); g.roundRect( b, b, W - 2 * b, H - 2 * b, Math.max( 0, r - b ) ); g.stroke();

	}

	const t = colorTexture( c, { repeat: false, anisotropy: o.anisotropy ?? 2 } );
	return t;

}

/**
 * 贴花网格：平面（或 curve 给定半径的圆柱面片），polygonOffset 防闪烁。默认朝 +z；放到表面外 0.0005–0.002 单位。
 * Decal mesh: a plane, or a cylinder patch when `curve` (radius) is given; polygonOffset prevents z-fighting.
 * Faces +z by default; place it 0.0005–0.002 units off the surface.
 * @param {THREE.Texture} texture
 * @param {{width?:number, height?:number, curve?:number, roughness?:number, metalness?:number, transparent?:boolean, emissive?:number}} [o]
 *   width/height 世界尺寸（默认宽 0.2，高按贴图宽高比）；curve 圆柱半径（标签绕在瓶身/镜筒上，圆柱轴为 y，标签中心在 +z）
 * 三角形 / triangles: 平面 2；圆柱面片 2 × 24
 * @returns {THREE.Mesh}
 */
export function decal( texture, o = {} ) {

	const img = texture.image, aspect = img ? img.height / img.width : 0.5;
	const w = o.width ?? 0.2, h = o.height ?? w * aspect;
	let geo;
	if ( o.curve ) {

		const arc = w / o.curve;
		geo = new THREE.CylinderGeometry( o.curve, o.curve, h, 24, 1, true, - arc / 2, arc );

	} else geo = new THREE.PlaneGeometry( w, h );
	const mat = new THREE.MeshStandardMaterial( {
		map: texture, transparent: o.transparent ?? true, roughness: o.roughness ?? 0.55, metalness: o.metalness ?? 0,
		polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 2, depthWrite: false,
	} );
	if ( o.emissive ) {

		mat.emissiveMap = texture; mat.emissive = new THREE.Color( 0xffffff ); mat.emissiveIntensity = o.emissive;

	}

	const m = new THREE.Mesh( geo, mat );
	m.name = 'decal';
	m.renderOrder = 1;
	return m;

}
