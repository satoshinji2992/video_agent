// Material presets with procedural maps: metal (brushed / polished / anodised / blasted), plastic (glossy / matte /
// textured), glass (clear / frosted, with a cheap fresnel-alpha fallback for software rendering), fabric (woven normal
// map + sheen), foil (crinkled metallic film), wood, ceramic and rubber. Each returns a MeshPhysicalMaterial or
// MeshStandardMaterial whose maps are generated once (≤ 512² by default, cached and shared between materials).
// Maps use the geometry's UVs: call worldUVs(geometry, tile) first for even density on boxes and extrusions, then
// `repeat` = tiles per UV unit. Or pass triplanar: <repeats per object unit> to project without UVs.
// 材质预设（程序化贴图）：金属、塑料、玻璃（含软件渲染下的廉价菲涅尔透明替代）、织物（编织法线 + 绒光）、锡箔、木材、陶瓷、橡胶。
// 贴图只生成一次（默认 ≤512²，缓存并在材质间共享）。贴图用几何 UV：盒子/拉伸体先 worldUVs(geometry, tile)；或传 triplanar 不用 UV。
import * as THREE from 'three';
import { makeRng, makeNoise2Periodic, makeNoise3, fbm2PeriodicXY, makeWorley2Periodic, hash3, smoothstep, clamp } from './noise.js';
import { cached, texSize, heightField, normalizeField, heightToNormalMap, fieldToDataTexture, colorTexture, dataTexture, paintCanvas, withRepeat } from './textures.js';
import { patchObjectSpace, triplanarDetail } from './shader.js';

/** 常用颜色（线性空间以外的 sRGB 十六进制）/ handy sRGB colours for presets. */
export const COLORS = {
	steel: 0xb4b6b9, aluminium: 0xc9cacc, chrome: 0xf2f2f2, titanium: 0xb5aea6, gold: 0xf2c46b, copper: 0xe8a07a, brass: 0xe1c37a,
	gunmetal: 0x55585c, black: 0x1c1c1e, white: 0xf3f3f1, red: 0xc0282d, blue: 0x2f5fb3, orange: 0xe8742a, green: 0x3f8f52,
};

const col = ( c, d ) => new THREE.Color( typeof c === 'string' && COLORS[ c ] !== undefined ? COLORS[ c ] : ( c ?? d ) );

/** 把一组贴图按 repeat 克隆到材质上（共享图像）/ attach maps with their own repeat (shared images). */
function attach( mat, maps, repeat ) {

	for ( const [ k, t ] of Object.entries( maps ) ) if ( t ) mat[ k ] = withRepeat( t, repeat );
	return mat;

}

/** 通用收尾：triplanar 选项（不用 UV）或按 UV 贴图 / finish: triplanar projection or UV maps. */
function finish( mat, maps, o, defRepeat = 1 ) {

	if ( o.triplanar ) {

		triplanarDetail( mat, { normalMap: maps.normalMap, roughnessMap: maps.roughnessMap, map: maps.map, scale: o.triplanar, strength: o.normalStrength ?? 1, fine: 0, cavity: 0, roughness: [ 0, 1 ] } );
		if ( maps.roughnessMap ) mat.roughness = 1;

	} else attach( mat, maps, o.repeat ?? defRepeat );
	if ( o.normalStrength !== undefined && mat.normalMap ) mat.normalScale.setScalar( o.normalStrength );
	mat.userData.kitPreset = o.preset;
	return mat;

}

// ---------------------------------------------------------------- shared map generators

/** 细颗粒（喷砂、哑光、磨砂）/ fine isotropic grain (blasted, matte, frosted). */
function grainMaps( seed, period, amp, rough, size = 256, strength = 1.5 ) {

	return cached( `grain:${seed}:${period}:${amp}:${rough}:${size}:${strength}`, () => {

		const n = makeNoise2Periodic( seed );
		const H = normalizeField( heightField( size, size, ( u, v ) => fbm2PeriodicXY( n, u, v, period, period, 3, 0.55 ) ) );
		return {
			normalMap: heightToNormalMap( H, { strength: strength * amp } ),
			roughnessMap: fieldToDataTexture( H, ( h ) => rough[ 0 ] + ( rough[ 1 ] - rough[ 0 ] ) * h ),
		};

	} );

}

/** 污渍/指纹般的低频斑块 → 粗糙度 / low-frequency smudges → roughness. */
function smudgeRoughness( seed, lo, hi, size = 256 ) {

	return cached( `smudge:${seed}:${lo}:${hi}:${size}`, () => {

		const n = makeNoise2Periodic( seed ), w = makeWorley2Periodic( seed + 5 );
		return dataTexture( paintCanvas( size, size, ( x, y, i, out ) => {

			const u = x / size, v = y / size;
			const b = smoothstep( 0.05, 0.45, fbm2PeriodicXY( n, u, v, 3, 3, 4 ) );
			const r = w( u, v, 5 );
			// Fingerprint-like concentric arcs in a few cells.
			const ring = Math.exp( - ( ( ( ( r.f1 * 9 ) % 1 ) - 0.5 ) ** 2 ) * 20 ) * smoothstep( 0.6, 0.2, r.f1 ) * ( r.id > 0.65 ? 1 : 0 );
			out[ 0 ] = out[ 1 ] = out[ 2 ] = 255 * ( lo + ( hi - lo ) * clamp( b * 0.8 + ring * 0.5 ) );

		} ) );

	} );

}

// ---------------------------------------------------------------- metal

/**
 * 金属 / metal.
 * @param {{finish?:'brushed'|'radial'|'polished'|'anodised'|'blasted', color?:THREE.ColorRepresentation|keyof COLORS, roughness?:number,
 *   repeat?:number|number[], triplanar?:number, seed?:number, normalStrength?:number, anisotropic?:boolean}} [o]
 *   finish：brushed 直线拉丝（沿 u，各向异性高光）、radial 同心拉丝（旋钮/盖子顶面，按 UV 中心）、polished 抛光（带污渍粗糙度）、
 *   anodised 阳极氧化（彩色、细砂面）、blasted 喷砂（哑光金属）；color 可用 COLORS 名（steel/aluminium/gold/copper/brass/titanium/gunmetal/black…）
 * 贴图 / textures: brushed 512²×2，radial 512²×2，polished 256²×1，anodised/blasted 256²×2（缓存共享）
 *   anisotropic:false 时拉丝不用各向异性高光（MeshStandardMaterial，更便宜）/ false: no anisotropic highlight (standard material, cheaper)
 * @returns {THREE.MeshPhysicalMaterial|THREE.MeshStandardMaterial} 拉丝为 Physical（各向异性），其余为 Standard / physical for brushed, standard otherwise
 */
export function metal( o = {} ) {

	const finish_ = o.finish ?? 'brushed', seed = o.seed ?? 1;
	const isAno = finish_ === 'anodised';
	// Physical only where it buys something (anisotropic brushing); standard is noticeably cheaper per pixel in SwiftShader.
	const brushed = finish_ === 'brushed' || finish_ === 'radial';
	const mat = new ( brushed && o.anisotropic !== false ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial )( { color: col( o.color, isAno ? 0x3f5f8f : brushed ? COLORS.steel : COLORS.aluminium ), metalness: 1, roughness: 1 } );
	let maps = {};
	if ( finish_ === 'brushed' || finish_ === 'radial' ) {

		const radial = finish_ === 'radial', size = 512;
		maps = cached( `brushed:${radial}:${seed}`, () => {

			const n = makeNoise2Periodic( seed * 3 + 1 ), n3 = makeNoise3( seed * 5 + 2 );
			const H = heightField( size, size, ( u, v ) => {

				if ( radial ) {

					const x = u - 0.5, y = v - 0.5, r = Math.hypot( x, y ), a = Math.atan2( y, x );
					return n3( r * 420, Math.cos( a ) * 1.5, Math.sin( a ) * 1.5 ) * 0.7 + n3( r * 1500, Math.cos( a ) * 4, Math.sin( a ) * 4 ) * 0.3;

				}

				return fbm2PeriodicXY( n, u, v, 2, 256, 2, 0.6 ) * 0.55 + fbm2PeriodicXY( n, u + 0.3, v, 4, 512, 1, 0.5 ) * 0.35 + fbm2PeriodicXY( n, u, v + 0.5, 2, 32, 2, 0.5 ) * 0.1;

			} );
			normalizeField( H );
			return {
				normalMap: heightToNormalMap( H, { strength: 1.6, wrap: ! radial, repeat: ! radial } ),
				roughnessMap: fieldToDataTexture( H, ( h ) => 0.2 + 0.16 * h, { repeat: ! radial } ),
			};

		} );
		if ( mat.isMeshPhysicalMaterial ) mat.anisotropy = 0.55; // highlight stretched across the brushing (tangent frame from UVs)

	} else if ( finish_ === 'polished' ) {

		maps = { roughnessMap: smudgeRoughness( seed, 0.05, 0.22 ) };

	} else {

		maps = grainMaps( seed * 7 + ( isAno ? 1 : 2 ), 48, isAno ? 0.5 : 1, isAno ? [ 0.32, 0.42 ] : [ 0.45, 0.6 ] );

	}

	if ( o.roughness !== undefined ) mat.roughness = o.roughness / ( { brushed: 0.3, radial: 0.3, polished: 0.12, anodised: 0.37, blasted: 0.52 }[ finish_ ] ?? 0.3 );
	if ( isAno ) {

		mat.metalness = 0.85;

	}

	return finish( mat, maps, { ...o, preset: 'metal:' + finish_ }, 1 );

}

// ---------------------------------------------------------------- plastic

/**
 * 塑料 / plastic.
 * @param {{finish?:'glossy'|'matte'|'textured', color?:THREE.ColorRepresentation, repeat?:number|number[], triplanar?:number, seed?:number, normalStrength?:number, clearcoat?:boolean}} [o]
 *   glossy 亮面（轻微橘皮；clearcoat:true 加清漆层，Physical，更贵）；matte 哑光（细颗粒，粗糙度起伏）；textured 皮纹/咬花（VDI 颗粒，产品外壳常见）
 * 贴图 / textures: 256²–512² ×2
 * @returns {THREE.MeshStandardMaterial|THREE.MeshPhysicalMaterial}
 */
export function plastic( o = {} ) {

	const f = o.finish ?? 'matte', seed = o.seed ?? 2;
	const mat = new ( f === 'glossy' && o.clearcoat ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial )( { color: col( o.color, 0x2d2f33 ), metalness: 0, roughness: 1 } );
	let maps;
	if ( f === 'glossy' ) {

		maps = grainMaps( seed, 12, 0.25, [ 0.12, 0.2 ], 256, 1 );
		if ( mat.isMeshPhysicalMaterial ) {

			mat.clearcoat = 0.6; mat.clearcoatRoughness = 0.06;

		}

	} else if ( f === 'textured' ) {

		maps = cached( `vdi:${seed}`, () => {

			const w = makeWorley2Periodic( seed * 3 + 1 ), n = makeNoise2Periodic( seed );
			const H = normalizeField( heightField( 512, 512, ( u, v ) => {

				const a = w( u, v, 40 ), b = w( u + 0.31, v + 0.17, 90 );
				return Math.pow( Math.max( 0, 1 - a.f1 * 1.3 ), 1.5 ) + 0.5 * Math.pow( Math.max( 0, 1 - b.f1 * 1.3 ), 1.5 ) + 0.25 * fbm2PeriodicXY( n, u, v, 8, 8, 3 );

			} ) );
			return { normalMap: heightToNormalMap( H, { strength: 3.5 } ), roughnessMap: fieldToDataTexture( H, ( h ) => 0.5 + 0.18 * ( 1 - h ) ) };

		} );

	} else {

		maps = grainMaps( seed, 64, 0.6, [ 0.5, 0.68 ], 256, 1.5 );

	}

	return finish( mat, maps, { ...o, preset: 'plastic:' + f }, f === 'textured' ? 2 : 1 );

}

// ---------------------------------------------------------------- glass

/**
 * 玻璃 / glass.
 * 默认便宜模式：不用 transmission，靠菲涅尔透明度——中心透出背景、边缘映出环境；软件渲染下几乎不加开销（不折射背景）。
 * real:true 用 MeshPhysicalMaterial.transmission（要额外渲染一遍场景，SwiftShader 下约 +40–100% 帧时间，只在玻璃是主角时用）。
 * Default cheap mode: fresnel alpha (background shows through the centre, the rim mirrors the environment; no
 * refraction), almost free in software rendering. real:true uses physical transmission (an extra scene pass, about +40–100% frame time in SwiftShader).
 * @param {{frosted?:boolean, real?:boolean, color?:THREE.ColorRepresentation, opacity?:number, thickness?:number, ior?:number, roughness?:number,
 *   repeat?:number|number[], seed?:number}} [o]
 *   frosted 磨砂（乳白、模糊高光）；opacity 便宜模式正面不透明度（默认 clear 0.06 / frosted 0.6）；thickness 透射厚度（real，默认 0.5）
 * 贴图 / textures: 磨砂 256² ×2；清玻璃无 / frosted 256² ×2, clear none
 * @returns {THREE.MeshPhysicalMaterial} 透明、双面 / transparent, double-sided
 */
export function glass( o = {} ) {

	const frosted = !! o.frosted, seed = o.seed ?? 3;
	const color = col( o.color, 0xffffff );
	let mat;
	if ( o.real ) {

		mat = new THREE.MeshPhysicalMaterial( { color, metalness: 0, roughness: o.roughness ?? ( frosted ? 0.4 : 0.02 ), transmission: 1, thickness: o.thickness ?? 0.5, ior: o.ior ?? 1.5, specularIntensity: 1 } );
		if ( frosted ) attach( mat, { normalMap: grainMaps( seed, 64, 0.5, [ 0.4, 0.5 ] ).normalMap }, o.repeat ?? 2 );
		mat.userData.kitPreset = frosted ? 'glass:frosted-real' : 'glass:real';
		return mat;

	}

	mat = new THREE.MeshPhysicalMaterial( {
		color: frosted ? color : color.clone().multiplyScalar( 0.004 ), metalness: 0, roughness: o.roughness ?? ( frosted ? 0.45 : 0.03 ),
		transparent: true, opacity: o.opacity ?? ( frosted ? 0.6 : 0.06 ), side: THREE.DoubleSide, depthWrite: false, ior: o.ior ?? 1.5,
	} );
	if ( frosted ) {

		attach( mat, grainMaps( seed, 64, 0.5, [ 0.38, 0.52 ] ), o.repeat ?? 2 );
		mat.roughness = 1;

	}

	// Fresnel alpha. Clear glass: the reflection is un-premultiplied (divided by alpha) and blended normally, so the
	// background shows through at the centre and the rim mirrors the room; additive blending would saturate in sRGB.
	patchObjectSpace( mat, { output: /* glsl */`
		float kF = 0.04 + 0.96 * pow( 1.0 - clamp( abs( dot( normal, normalize( vViewPosition ) ) ), 0.0, 1.0 ), 5.0 );
		float kA = clamp( gl_FragColor.a + ( 1.0 - gl_FragColor.a ) * kF, 0.0, 1.0 );
		// Bright reflections (softboxes, sun glints) stay visible: they cover what is behind.
		kA = max( kA, clamp( ( dot( gl_FragColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) - 0.12 ) * 1.5, 0.0, 0.9 ) );
		${frosted ? '' : 'gl_FragColor.rgb /= max( kA, 0.04 );'}
		gl_FragColor.a = kA;` } );
	mat.userData.kitPreset = frosted ? 'glass:frosted' : 'glass:clear';
	return mat;

}

// ---------------------------------------------------------------- fabric

/**
 * 织物 / fabric: 编织法线（经纬线交错），线色深浅不一，绒光 sheen。
 * Woven normal map (over/under threads), per-thread colour variation and sheen.
 * @param {{weave?:'plain'|'twill'|'ripstop'|'canvas'|'satin', color?:THREE.ColorRepresentation, color2?:THREE.ColorRepresentation,
 *   threads?:number, sheen?:number, repeat?:number|number[], triplanar?:number, seed?:number, normalStrength?:number}} [o]
 *   plain 平纹；twill 斜纹（牛仔、卡其）；ripstop 防撕格（背包尼龙）；canvas 帆布（粗线、不匀）；satin 缎纹（光滑浮线）；
 *   color2 纬线颜色（默认同 color 稍亮，牛仔用白色）；threads 每张贴图经线数（默认 32）；sheen 绒光强度（默认 0.35；镜面反射已压低到 0.4，深色布料不发灰）
 * 贴图 / textures: 512² ×3（法线、粗糙度、颜色）
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function fabric( o = {} ) {

	const weave = o.weave ?? 'plain', T = o.threads ?? 32, seed = o.seed ?? 4;
	const c1 = col( o.color, 0x3a4a6a ), c2 = o.color2 !== undefined ? col( o.color2 ) : c1.clone().offsetHSL( 0, - 0.05, 0.06 );
	const maps = cached( `fabric:${weave}:${T}:${seed}:${c1.getHex()}:${c2.getHex()}`, () => {

		const size = 512, n = makeNoise2Periodic( seed ), cell = size / T;
		const H = new Float32Array( size * size ), C = new Uint8ClampedArray( size * size * 3 );
		const thick = ( i, k ) => 0.85 + 0.3 * hash3( i, k, 0, seed ); // per-thread thickness
		const tone = ( i, k ) => 0.88 + 0.24 * hash3( i, k, 1, seed );
		const prof = ( t ) => Math.sqrt( Math.max( 0, 1 - ( 2 * t - 1 ) ** 2 ) );
		const tmp = new THREE.Color();
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			const X = x / cell, Y = y / cell, i = Math.floor( X ), j = Math.floor( Y ), fx = X - i, fy = Y - j;
			let warpOver;
			if ( weave === 'twill' ) warpOver = ( ( i + j ) % 4 + 4 ) % 4 < 2;
			else if ( weave === 'satin' ) warpOver = ( ( i * 2 + j ) % 5 + 5 ) % 5 !== 0;
			else warpOver = ( i + j ) % 2 === 0;
			const rip = weave === 'ripstop' ? 1 : 0;
			const wT = thick( i, 0 ) * ( rip && i % 8 === 0 ? 1.5 : 1 ) * ( weave === 'canvas' ? 1.15 : 1 );
			const fT = thick( j, 1 ) * ( rip && j % 8 === 0 ? 1.5 : 1 ) * ( weave === 'canvas' ? 1.15 : 1 );
			const fib = 0.06 * n( x / size * 4, y / size * 128, 4, 128 ), fibW = 0.06 * n( x / size * 128 + 3, y / size * 4, 128, 4 );
			// warp runs along v (vertical), weft along u.
			const hw = prof( fx ) * wT * ( warpOver ? 0.75 + 0.25 * Math.sin( Math.PI * fy ) : 0.35 ) + fib;
			const hf = prof( fy ) * fT * ( warpOver ? 0.35 : 0.75 + 0.25 * Math.sin( Math.PI * fx ) ) + fibW;
			const isWarp = hw >= hf;
			const h = Math.max( hw, hf ) + ( rip && ( i % 8 === 0 || j % 8 === 0 ) ? 0.15 : 0 );
			H[ y * size + x ] = h;
			tmp.copy( isWarp ? c1 : c2 ).multiplyScalar( ( isWarp ? tone( i, 0 ) : tone( j, 1 ) ) * ( 0.7 + 0.3 * Math.min( 1, h ) ) );
			tmp.convertLinearToSRGB();
			C[ ( y * size + x ) * 3 ] = tmp.r * 255; C[ ( y * size + x ) * 3 + 1 ] = tmp.g * 255; C[ ( y * size + x ) * 3 + 2 ] = tmp.b * 255;

		}

		const F = normalizeField( { data: H, width: size, height: size } );
		const map = colorTexture( paintCanvas( size, size, ( x, y, i, out ) => {

			out[ 0 ] = C[ i * 3 ]; out[ 1 ] = C[ i * 3 + 1 ]; out[ 2 ] = C[ i * 3 + 2 ];

		} ) );
		return { normalMap: heightToNormalMap( F, { strength: 2.2 } ), roughnessMap: fieldToDataTexture( F, ( h ) => 0.95 - 0.15 * h ), map };

	} );
	const mat = new THREE.MeshPhysicalMaterial( {
		color: 0xffffff, metalness: 0, roughness: 1, specularIntensity: 0.4,
		// Sheen tinted by the cloth colour (a white sheen washes dark fabric out to grey).
		sheen: o.sheen ?? 0.35, sheenRoughness: 0.6, sheenColor: c1.clone().multiplyScalar( 1.8 ).lerp( new THREE.Color( 0xffffff ), 0.08 ),
	} );
	return finish( mat, maps, { ...o, preset: 'fabric:' + weave }, 8 );

}

// ---------------------------------------------------------------- foil

/**
 * 锡箔/金属膜（揉皱）：随机朝向的平面碎片 + 折痕，镜面高光碎成一片片闪光。
 * Crinkled metallic film: randomly tilted flat facets plus creases, so highlights break into glints.
 * @param {{color?:THREE.ColorRepresentation, crinkle?:number, facets?:number, roughness?:number, repeat?:number|number[], triplanar?:number, seed?:number}} [o]
 *   color 默认金色（可 'chrome'/'copper' 或任意色）；crinkle 皱的程度（默认 1）；facets 每张贴图碎片数（默认 14）
 * 贴图 / textures: 512² ×2
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function foil( o = {} ) {

	const seed = o.seed ?? 5, crinkle = o.crinkle ?? 1, facets = o.facets ?? 14;
	const maps = cached( `foil:${seed}:${crinkle}:${facets}`, () => {

		const size = 512, w = makeWorley2Periodic( seed ), w2 = makeWorley2Periodic( seed + 9 ), n = makeNoise2Periodic( seed + 3 );
		const sx = new Float32Array( size * size ), sy = new Float32Array( size * size );
		const H = heightField( size, size, ( u, v, x, y ) => {

			const a = w( u, v, facets ), b = w2( u, v, facets * 2.3 | 0 );
			const i = y * size + x;
			// Facet slopes (flat pieces) at two scales.
			sx[ i ] = ( ( a.id - 0.5 ) * 0.9 + ( b.id - 0.5 ) * 0.45 ) * crinkle;
			sy[ i ] = ( ( a.id2 - 0.5 ) * 0.9 + ( hash3( Math.floor( b.id * 1e4 ), 3, 0, seed ) - 0.5 ) * 0.45 ) * crinkle;
			// Creases where cells meet, plus a little wrinkle noise.
			return - ( 1 - smoothstep( 0, 0.06, a.f2 - a.f1 ) ) * 0.6 - ( 1 - smoothstep( 0, 0.05, b.f2 - b.f1 ) ) * 0.3 + 0.15 * fbm2PeriodicXY( n, u, v, 16, 16, 3 );

		} );
		normalizeField( H );
		return {
			normalMap: heightToNormalMap( H, { strength: 3 * crinkle, slopes: { x: sx, y: sy } } ),
			roughnessMap: fieldToDataTexture( H, ( h ) => 0.12 + 0.18 * ( 1 - h ) ),
		};

	} );
	const mat = new THREE.MeshPhysicalMaterial( { color: col( o.color, COLORS.gold ), metalness: 1, roughness: o.roughness !== undefined ? o.roughness / 0.2 : 1 } );
	return finish( mat, maps, { ...o, preset: 'foil' }, 1 );

}

// ---------------------------------------------------------------- wood

/**
 * 木材：年轮带（早材/晚材两色）+ 顺纹导管小孔 + 细纹，纹理沿 u。lacquered 加清漆层。
 * Wood: growth bands (early/late wood colours), pores and fine grain along u. lacquered adds a clearcoat.
 * @param {{color?:THREE.ColorRepresentation, color2?:THREE.ColorRepresentation, rings?:number, finish?:'oiled'|'lacquered'|'raw',
 *   repeat?:number|number[], triplanar?:number, seed?:number, normalStrength?:number}} [o]
 *   color 早材（浅，默认橡木）；color2 晚材（深）；rings 每张贴图年轮数（默认 14）
 * 贴图 / textures: 512² ×3
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function wood( o = {} ) {

	const seed = o.seed ?? 6, rings = o.rings ?? 14, c1 = col( o.color, 0xb98a58 ), c2 = col( o.color2, 0x7a4a26 );
	const maps = cached( `wood:${seed}:${rings}:${c1.getHex()}:${c2.getHex()}`, () => {

		const size = 512, n = makeNoise2Periodic( seed ), n2 = makeNoise2Periodic( seed + 1 ), tmp = new THREE.Color();
		const H = new Float32Array( size * size ), C = new Uint8ClampedArray( size * size * 3 );
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			const u = x / size, v = y / size;
			const warp = fbm2PeriodicXY( n, u, v, 1, 2, 4 ) * 0.6;
			const t = ( v * rings + warp * 1.6 + 0.15 * Math.sin( u * Math.PI * 2 * 2 + v * 7 ) ) % 1;
			const ring = Math.pow( smoothstep( 0.55, 0.95, ( t + 1 ) % 1 ), 1.5 ); // sharp late-wood band
			const grain = fbm2PeriodicXY( n2, u, v, 3, 96, 3, 0.6 );
			const pore = smoothstep( 0.35, 0.6, n2( u * 8 + 0.5, v * 220, 8, 220 ) ) * smoothstep( 0.3, 0.7, n( u * 24 + 0.2, v * 220 + 0.4, 24, 220 ) );
			const i = y * size + x;
			H[ i ] = 1 - 0.35 * ring - 0.5 * pore + 0.12 * grain;
			tmp.copy( c1 ).lerp( c2, clamp( ring * 0.85 + grain * 0.18 + 0.1 ) ).multiplyScalar( 1 - 0.35 * pore );
			tmp.convertLinearToSRGB();
			C[ i * 3 ] = tmp.r * 255; C[ i * 3 + 1 ] = tmp.g * 255; C[ i * 3 + 2 ] = tmp.b * 255;

		}

		const F = normalizeField( { data: H, width: size, height: size } );
		return {
			map: colorTexture( paintCanvas( size, size, ( x, y, i, out ) => {

				out[ 0 ] = C[ i * 3 ]; out[ 1 ] = C[ i * 3 + 1 ]; out[ 2 ] = C[ i * 3 + 2 ];

			} ) ),
			normalMap: heightToNormalMap( F, { strength: 2.5 } ),
			roughnessMap: fieldToDataTexture( F, ( h ) => 0.5 + 0.25 * ( 1 - h ) ),
		};

	} );
	const fin = o.finish ?? 'oiled';
	const mat = new ( fin === 'lacquered' ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial )( { color: 0xffffff, metalness: 0, roughness: fin === 'raw' ? 1.2 : 1 } );
	if ( fin === 'lacquered' ) {

		mat.clearcoat = 0.8; mat.clearcoatRoughness = 0.12;

	}

	return finish( mat, maps, { ...o, preset: 'wood:' + fin }, 1 );

}

// ---------------------------------------------------------------- ceramic

/**
 * 陶瓷 / ceramic: glossy 亮釉（清漆层 + 轻微橘皮 + 可选铁点）；matte 哑光粗陶（斑点）；crackle 开片釉（裂纹线）。
 * @param {{glaze?:'glossy'|'matte'|'crackle', color?:THREE.ColorRepresentation, speckle?:number, repeat?:number|number[], triplanar?:number, seed?:number}} [o]
 *   speckle 斑点密度 0..1（默认 glossy 0.15 / matte 0.6 / crackle 0）
 * 贴图 / textures: 512² ×3
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function ceramic( o = {} ) {

	const glaze = o.glaze ?? 'glossy', seed = o.seed ?? 7, sp = o.speckle ?? { glossy: 0.15, matte: 0.6, crackle: 0 }[ glaze ] ?? 0.2;
	const maps = cached( `ceramic:${glaze}:${seed}:${sp}`, () => {

		const size = 512, n = makeNoise2Periodic( seed ), w = makeWorley2Periodic( seed + 2 ), w2 = makeWorley2Periodic( seed + 4 ), rng = makeRng( seed );
		const spots = [];
		for ( let i = 0; i < 400 * sp; i ++ ) spots.push( [ rng.next() * size, rng.next() * size, rng.range( 0.6, 2.2 ) ] );
		const S = new Float32Array( size * size );
		for ( const [ cx, cy, r ] of spots ) for ( let y = - 3; y <= 3; y ++ ) for ( let x = - 3; x <= 3; x ++ ) {

			const d = Math.hypot( x + ( cx % 1 ), y + ( cy % 1 ) ) / r;
			const k = ( ( Math.floor( cy ) + y + size ) % size ) * size + ( ( Math.floor( cx ) + x + size ) % size );
			if ( d < 1 ) S[ k ] = Math.max( S[ k ], 1 - d * d );

		}

		const crack = new Float32Array( size * size );
		const H = heightField( size, size, ( u, v, x, y ) => {

			let h = fbm2PeriodicXY( n, u, v, 12, 12, 3 ) * ( glaze === 'matte' ? 0.6 : 0.25 );
			if ( glaze === 'crackle' ) {

				const a = w( u, v, 9 ), b = w2( u, v, 23 );
				const c = Math.max( 1 - smoothstep( 0, 0.035, a.f2 - a.f1 ), 0.6 * ( 1 - smoothstep( 0, 0.03, b.f2 - b.f1 ) ) );
				crack[ y * size + x ] = c;
				h -= c * 0.5;

			}

			return h;

		} );
		normalizeField( H );
		const map = colorTexture( paintCanvas( size, size, ( x, y, i, out ) => {

			const v = ( 1 - 0.75 * S[ i ] ) * ( 1 - 0.7 * crack[ i ] ) * ( glaze === 'matte' ? 0.92 + 0.08 * H.data[ i ] : 1 );
			out[ 0 ] = out[ 1 ] = out[ 2 ] = 255 * Math.pow( v, 1 / 2.2 );

		} ) );
		return {
			map, normalMap: heightToNormalMap( H, { strength: glaze === 'matte' ? 2 : 0.8 } ),
			roughnessMap: fieldToDataTexture( H, ( h ) => ( glaze === 'matte' ? 0.72 : 0.22 ) + 0.1 * ( 1 - h ) ),
		};

	} );
	const mat = new THREE.MeshPhysicalMaterial( { color: col( o.color, 0xf0ece4 ), metalness: 0, roughness: 1 } );
	if ( glaze !== 'matte' ) {

		mat.clearcoat = 1; mat.clearcoatRoughness = 0.06;

	}

	return finish( mat, maps, { ...o, preset: 'ceramic:' + glaze }, 1 );

}

// ---------------------------------------------------------------- rubber

/**
 * 橡胶 / rubber: 哑光、深色、细微颗粒；pattern 防滑纹：knurl 菱形滚花、dots 圆点、ribs 横棱、none。
 * @param {{pattern?:'none'|'knurl'|'dots'|'ribs', color?:THREE.ColorRepresentation, repeat?:number|number[], triplanar?:number, seed?:number, normalStrength?:number}} [o]
 * 贴图 / textures: 256²–512² ×2
 * @returns {THREE.MeshStandardMaterial}
 */
export function rubber( o = {} ) {

	const pattern = o.pattern ?? 'none', seed = o.seed ?? 8;
	const maps = pattern === 'none' ? grainMaps( seed, 96, 0.5, [ 0.78, 0.92 ], 256, 1.2 ) : cached( `rubber:${pattern}:${seed}`, () => {

		const size = 512, n = makeNoise2Periodic( seed ), K = 16;
		const H = normalizeField( heightField( size, size, ( u, v ) => {

			let h;
			if ( pattern === 'knurl' ) {

				const a = Math.abs( ( ( u + v ) * K ) % 1 - 0.5 ), b = Math.abs( ( ( u - v + 1 ) * K ) % 1 - 0.5 );
				h = smoothstep( 0.02, 0.2, Math.min( a, b ) );

			} else if ( pattern === 'dots' ) {

				const x = ( u * K ) % 1 - 0.5, y = ( v * K ) % 1 - 0.5;
				h = smoothstep( 0.32, 0.26, Math.hypot( x, y ) );

			} else {

				h = smoothstep( 0.1, 0.25, Math.abs( ( v * K ) % 1 - 0.5 ) );

			}

			return h + 0.04 * fbm2PeriodicXY( n, u, v, 64, 64, 2 );

		} ) );
		return { normalMap: heightToNormalMap( H, { strength: 5 } ), roughnessMap: fieldToDataTexture( H, ( h ) => 0.88 - 0.12 * h ) };

	} );
	const mat = new THREE.MeshStandardMaterial( { color: col( o.color, 0x1b1b1b ), metalness: 0, roughness: 1 } );
	return finish( mat, maps, { ...o, preset: 'rubber:' + pattern }, pattern === 'none' ? 2 : 1 );

}

/**
 * 按名字取预设 / preset by name: 'metal:brushed' | 'plastic:matte' | 'glass:frosted' | 'fabric:ripstop' | 'foil' | 'wood' | 'ceramic:crackle' | 'rubber:knurl' …
 * @param {string} name 类型[:变体] / kind[:variant]
 * @param {object} [o] 其余参数 / other options
 */
export function material( name, o = {} ) {

	const [ kind, v ] = name.split( ':' );
	switch ( kind ) {

		case 'metal': return metal( { finish: v, ...o } );
		case 'plastic': return plastic( { finish: v, ...o } );
		case 'glass': return glass( { frosted: v === 'frosted', ...o } );
		case 'fabric': return fabric( { weave: v, ...o } );
		case 'foil': return foil( o );
		case 'wood': return wood( { finish: v, ...o } );
		case 'ceramic': return ceramic( { glaze: v, ...o } );
		case 'rubber': return rubber( { pattern: v, ...o } );
		default: throw new Error( `kit.material: unknown preset ${name}` );

	}

}
