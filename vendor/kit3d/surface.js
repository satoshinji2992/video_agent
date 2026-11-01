// Surface detail for rock-like and organic surfaces: dense base shapes (icosphere, super-ellipsoid, subdivision),
// seeded displacement (fbm / ridged / domain warp / cells / pits and bumps / grooves / flat base), curvature-based
// vertex tint (dark cavities, worn edges), and tileable detail maps (normal + roughness + tint) for the fine scale.
// Recipes turn the same calls into rock, stone, bark, bread crust, clay or terrain by parameters only.
// 岩石与有机表面细节：致密基础形（细分二十面体、超椭球、细分）、带种子的置换（fbm / 脊状 / 域扭曲 / 胞格 / 坑与包 / 沟 / 平底）、
// 按曲率上色（凹处暗、凸棱亮）、可平铺细节贴图（法线 + 粗糙度 + 色斑）。同一套调用只改参数就是岩石、卵石、树皮、面包皮、陶土、地形。
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, makeNoise3, fbm3, ridged3, makeWorley3, makeNoise2Periodic, fbm2PeriodicXY, makeWorley2Periodic, smin, smax, smoothstep, clamp } from './noise.js';
import { cached, texSize, heightField, normalizeField, heightToNormalMap, roughnessFromHeight, tintFromHeight, boxProjectUVs, packDetailTexture } from './textures.js';
import { triplanarDetail } from './shader.js';

// ---------------------------------------------------------------- base shapes

/**
 * 均匀细分的球（索引几何、顶点共享、平滑法线）/ uniformly subdivided sphere (indexed, shared vertices, smooth normals).
 * @param {number} [radius=1]
 * @param {number} [detail=48] 细分数 / subdivision
 * 三角形 / triangles: 20·(detail+1)² （32 → 21,780；48 → 48,020；63 → 81,920）
 * @returns {THREE.BufferGeometry} 无 UV（用三平面细节或 boxProjectUVs）/ no UVs (use triplanar detail or boxProjectUVs)
 */
export function icosphere( radius = 1, detail = 48 ) {

	let g = new THREE.IcosahedronGeometry( radius, detail );
	g.deleteAttribute( 'uv' ); g.deleteAttribute( 'normal' );
	g = mergeVertices( g, 1e-6 * radius );
	g.computeVertexNormals();
	return g;

}

/**
 * 超椭球（从球到圆角方块之间连续变化）：面包、枕头、肥皂、卵石、圆角机身的致密基础形。
 * Super-ellipsoid, anywhere between an ellipsoid and a rounded block: a dense base for loaves, cushions, pebbles, soft bodies.
 * 由细分立方体投影得到，网格比球更均匀分布在平面区域。/ Built from a subdivided cube, so flat-ish faces get even triangles.
 * @param {number[]} [size=[1,1,1]] 三轴全尺寸 [x,y,z] / full extents
 * @param {{power?:number, segments?:number, bottom?:number, uvTile?:number}} [o]
 *   power：2 = 椭球，3–4 = 软方块，8+ = 硬方块（默认 3）；segments：每面每边格数（默认 40）；
 *   bottom：0..1，底部削平的程度（0.5 ≈ 削掉下方 22%，默认 0）；uvTile：给盒式投影 UV 的平铺尺寸（默认 1，0 不生成）
 *   / power: 2 ellipsoid, 3–4 soft block, 8+ hard block (default 3); segments per cube edge (40); bottom flattening 0..1; uvTile for box UVs
 * 三角形 / triangles: 12·segments² （32 → 12,288；40 → 19,200；64 → 49,152；90 → 97,200）
 * @returns {THREE.BufferGeometry}
 */
export function superEllipsoid( size = [ 1, 1, 1 ], o = {} ) {

	const n = Math.max( 2, Math.round( o.segments ?? 40 ) ), p = Math.max( 2, o.power ?? 3 );
	let g = new THREE.BoxGeometry( 2, 2, 2, n, n, n );
	g.deleteAttribute( 'uv' ); g.deleteAttribute( 'normal' );
	g = mergeVertices( g, 1e-6 );
	const pos = g.attributes.position, warp = clamp( ( p - 2 ) / 4, 0, 1 );
	const flat = o.bottom ?? 0;
	for ( let i = 0; i < pos.count; i ++ ) {

		let x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
		// Equal-angle warp for round shapes (even triangles on the sphere), plain cube grid for boxy ones.
		const tw = ( t ) => t * warp + Math.tan( t * Math.PI / 4 ) * ( 1 - warp );
		x = tw( x ); y = tw( y ); z = tw( z );
		const l = Math.hypot( x, y, z );
		x /= l; y /= l; z /= l;
		const k = Math.pow( Math.pow( Math.abs( x ), p ) + Math.pow( Math.abs( y ), p ) + Math.pow( Math.abs( z ), p ), - 1 / p );
		x *= k; y *= k; z *= k;
		if ( flat > 0 ) y = smax( y, - ( 1 - 0.45 * flat ), 0.12 ); // cut a soft-edged flat base
		pos.setXYZ( i, x * size[ 0 ] / 2, y * size[ 1 ] / 2, z * size[ 2 ] / 2 );

	}

	g.computeVertexNormals();
	if ( ( o.uvTile ?? 1 ) > 0 ) boxProjectUVs( g, o.uvTile ?? 1 );
	return g;

}

/**
 * 线性细分：每级把每个三角形切成 4 个（保留并插值 UV/法线/颜色），让盒子、车削体、拉伸体能被置换。
 * Linear subdivision: each level splits every triangle into 4 (UVs, normals, colours interpolated), so boxes, lathes and
 * extrusions become dense enough to displace.
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [levels=1]
 * 三角形 / triangles: 原数 × 4^levels / input × 4^levels
 * @returns {THREE.BufferGeometry} 非索引新几何 / new non-indexed geometry
 */
export function subdivide( geometry, levels = 1 ) {

	let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
	for ( let l = 0; l < levels; l ++ ) {

		const names = Object.keys( g.attributes ), out = {};
		const tri = g.attributes.position.count / 3;
		for ( const name of names ) {

			const a = g.attributes[ name ], s = a.itemSize, src = a.array, dst = new Float32Array( tri * 12 * s );
			const mid = new Float32Array( s * 3 );
			let o = 0;
			const put = ( arr, off ) => {

				for ( let k = 0; k < s; k ++ ) dst[ o ++ ] = arr[ off + k ];

			};

			for ( let t = 0; t < tri; t ++ ) {

				const A = t * 3 * s, B = A + s, C = B + s;
				for ( let k = 0; k < s; k ++ ) {

					mid[ k ] = ( src[ A + k ] + src[ B + k ] ) / 2;
					mid[ s + k ] = ( src[ B + k ] + src[ C + k ] ) / 2;
					mid[ 2 * s + k ] = ( src[ C + k ] + src[ A + k ] ) / 2;

				}

				put( src, A ); put( mid, 0 ); put( mid, 2 * s );
				put( mid, 0 ); put( src, B ); put( mid, s );
				put( mid, 2 * s ); put( mid, s ); put( src, C );
				put( mid, 0 ); put( mid, s ); put( mid, 2 * s );

			}

			out[ name ] = new THREE.BufferAttribute( dst, s, a.normalized );

		}

		g = new THREE.BufferGeometry();
		for ( const name of names ) g.setAttribute( name, out[ name ] );

	}

	return g;

}

// ---------------------------------------------------------------- shared-position topology

/**
 * 按位置归并顶点（UV 缝、硬边处的重复顶点视为同一点），返回每个顶点所属的槽与槽坐标。
 * Group vertices by position (duplicates at UV seams and hard edges share one slot).
 * @returns {{slotOf:Int32Array, count:number, pos:Float32Array}}
 */
export function positionSlots( geometry ) {

	const p = geometry.attributes.position, n = p.count;
	geometry.computeBoundingSphere();
	const q = 1e6 / Math.max( 1e-9, geometry.boundingSphere.radius );
	const map = new Map(), slotOf = new Int32Array( n ), pos = [];
	for ( let i = 0; i < n; i ++ ) {

		const x = p.getX( i ), y = p.getY( i ), z = p.getZ( i );
		const key = Math.round( x * q ) + ',' + Math.round( y * q ) + ',' + Math.round( z * q );
		let s = map.get( key );
		if ( s === undefined ) {

			s = pos.length / 3; map.set( key, s ); pos.push( x, y, z );

		}

		slotOf[ i ] = s;

	}

	return { slotOf, count: pos.length / 3, pos: new Float32Array( pos ) };

}

function forTriangles( geometry, fn ) {

	const idx = geometry.index, n = idx ? idx.count : geometry.attributes.position.count;
	for ( let t = 0; t < n; t += 3 ) {

		if ( idx ) fn( idx.getX( t ), idx.getX( t + 1 ), idx.getX( t + 2 ) );
		else fn( t, t + 1, t + 2 );

	}

}

/** 槽法线（面积加权）/ area-weighted normal per position slot. */
function slotNormals( geometry, S ) {

	const P = S.pos, N = new Float32Array( S.count * 3 );
	forTriangles( geometry, ( a, b, c ) => {

		const A = S.slotOf[ a ] * 3, B = S.slotOf[ b ] * 3, C = S.slotOf[ c ] * 3;
		const ux = P[ B ] - P[ A ], uy = P[ B + 1 ] - P[ A + 1 ], uz = P[ B + 2 ] - P[ A + 2 ];
		const vx = P[ C ] - P[ A ], vy = P[ C + 1 ] - P[ A + 1 ], vz = P[ C + 2 ] - P[ A + 2 ];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for ( const s of [ A, B, C ] ) {

			N[ s ] += nx; N[ s + 1 ] += ny; N[ s + 2 ] += nz;

		}

	} );
	for ( let s = 0; s < S.count; s ++ ) {

		const l = Math.hypot( N[ s * 3 ], N[ s * 3 + 1 ], N[ s * 3 + 2 ] ) || 1;
		N[ s * 3 ] /= l; N[ s * 3 + 1 ] /= l; N[ s * 3 + 2 ] /= l;

	}

	return N;

}

/**
 * 平滑法线：同一位置的重复顶点（UV 缝、盒子棱）取同一法线，置换后不会出现接缝亮线。
 * Smooth normals across duplicated vertices (UV seams, box edges): no shading seams after displacement.
 * @param {THREE.BufferGeometry} geometry
 */
export function smoothNormals( geometry ) {

	const S = positionSlots( geometry );
	const N = slotNormals( geometry, S ), n = geometry.attributes.position.count, out = new Float32Array( n * 3 );
	for ( let i = 0; i < n; i ++ ) {

		const s = S.slotOf[ i ] * 3;
		out[ i * 3 ] = N[ s ]; out[ i * 3 + 1 ] = N[ s + 1 ]; out[ i * 3 + 2 ] = N[ s + 2 ];

	}

	geometry.setAttribute( 'normal', new THREE.BufferAttribute( out, 3 ) );
	return geometry;

}

// ---------------------------------------------------------------- displacement

/** 随机平面削切（原地改槽坐标）/ chip slot positions with random planes, in place. */
function cutFacets( S, f, rng ) {

	const P = S.pos, depth = f.depth ?? 0.2, k = Math.max( 1e-6, f.soft ?? 0.02 );
	let cx = 0, cy = 0, cz = 0;
	for ( let s = 0; s < S.count; s ++ ) {

		cx += P[ s * 3 ]; cy += P[ s * 3 + 1 ]; cz += P[ s * 3 + 2 ];

	}

	cx /= S.count; cy /= S.count; cz /= S.count;
	for ( let i = 0; i < f.count; i ++ ) {

		const [ nx, ny, nz ] = rng.dir();
		let hi = - Infinity;
		for ( let s = 0; s < S.count; s ++ ) hi = Math.max( hi, ( P[ s * 3 ] - cx ) * nx + ( P[ s * 3 + 1 ] - cy ) * ny + ( P[ s * 3 + 2 ] - cz ) * nz );
		const d = hi * ( 1 - depth * rng.range( 0.4, 1.6 ) );
		for ( let s = 0; s < S.count; s ++ ) {

			const e = ( P[ s * 3 ] - cx ) * nx + ( P[ s * 3 + 1 ] - cy ) * ny + ( P[ s * 3 + 2 ] - cz ) * nz - d;
			if ( e <= - k ) continue;
			const shift = e >= k ? e : ( e + k ) * ( e + k ) / ( 4 * k );
			P[ s * 3 ] -= nx * shift; P[ s * 3 + 1 ] -= ny * shift; P[ s * 3 + 2 ] -= nz * shift;

		}

	}

}

/**
 * 沿法线置换（确定性，种子化）：大形起伏 + 脊 + 胞格（裂缝/石块/鼓包）+ 坑与包 + 沟槽 + 平底。
 * Seeded displacement along the (shared) normal: broad fbm + ridges + cells (cracks / cobbles / blisters) + pits and
 * bumps + grooves + a flat base. Works on any geometry dense enough (icosphere, superEllipsoid, subdivide(...), a
 * segmented Lathe/Plane/Box); duplicated vertices move together, so UV seams and box edges never crack.
 *
 * @param {THREE.BufferGeometry} geometry 原地修改 / modified in place
 * @param {object} [o]
 * @param {number} [o.seed=1] 种子 / seed
 * @param {number} [o.amplitude=0.08] 主起伏幅度（世界单位）/ broad relief amplitude (world units)
 * @param {number|number[]} [o.scale=2] 每单位多少个起伏；[x,y,z] 拉伸（树皮竖沟：[6,0.8,6]）/ features per unit; per-axis to stretch
 * @param {number} [o.octaves=5] fbm 层数 / octaves
 * @param {number} [o.gain=0.5] 每层幅度衰减 / per-octave gain
 * @param {number|boolean} [o.ridged=0] 0..1 脊状噪声占比（山脊、褶皱、树皮）/ share of ridged noise (crests, folds)
 * @param {number} [o.warp=0] 0..1 域扭曲（更有机、流动）/ domain warp amount (more organic)
 * @param {{amount:number, scale?:number, mode?:'cracks'|'plateaus'|'bumps', width?:number}} [o.cells]
 *   Worley 胞格：cracks 裂缝网（干泥、石缝），plateaus 一块块石头/鳞片，bumps 圆鼓包（面包气泡、橘皮）；amount 世界单位
 * @param {{count:number, size?:number[], depth?:number, rim?:number, bumps?:number, filter?:(p:THREE.Vector3,n:THREE.Vector3)=>boolean}} [o.pits]
 *   坑与包：count 个，半径 size=[min,max]（世界单位，幂律分布，默认 [0.03,0.15]），depth 深度/半径（默认 0.35），
 *   rim 坑缘隆起 0..1（默认 0.4），bumps 其中鼓包的比例 0..1（默认 0）；filter 只在满足条件的位置放
 *   / pits & bumps with power-law radii, bowl + raised rim profile; `bumps` share are domes instead
 * @param {{a:number[], b:number[], width:number, depth:number}[]} [o.grooves] 线段沟槽（划痕、刀口、裂缝）/ segment grooves (scores, cuts)
 * @param {{count:number, depth?:number, soft?:number}} [o.facets] 先用 count 个随机平面削去外凸部分，得到崩口/切面（棱角石块、碎块、晶体），
 *   depth 平均削去深度（占半径比例，默认 0.2），soft 切面交界的圆滑宽度（世界单位，默认 0.02）；之后的噪声叠加在切面上
 *   / chip the shape with count random planes first (angular stones, chunks, crystals); noise is added on top
 * @param {{y:number, soft?:number}} [o.base] 把 y 以下压平（放在地上），soft 圆角宽度 / flatten below y with a soft edge
 * 三角形 / triangles: 不变（与输入相同）/ unchanged. CPU ≈ 40k 顶点 50–150 ms。
 * @returns {THREE.BufferGeometry} 写入属性 kitHeight（置换量 / amplitude）与平滑法线 / adds attribute kitHeight and smooth normals
 */
export function displace( geometry, o = {} ) {

	if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
	const seed = o.seed ?? 1, amp = o.amplitude ?? 0.08;
	const sc = Array.isArray( o.scale ) ? o.scale : [ o.scale ?? 2, o.scale ?? 2, o.scale ?? 2 ];
	const ridged = o.ridged === true ? 1 : ( o.ridged || 0 ), warp = o.warp ?? 0;
	const fo = { octaves: o.octaves ?? 5, gain: o.gain ?? 0.5, lacunarity: 2.03 };
	const rng = makeRng( seed );
	const noise = makeNoise3( seed * 7 + 1 ), noiseB = makeNoise3( seed * 13 + 5 ), noiseW = makeNoise3( seed * 31 + 9 );
	const worley = makeWorley3( seed * 3 + 2 );
	const S = positionSlots( geometry ), P = S.pos;
	if ( o.facets?.count ) cutFacets( S, o.facets, makeRng( seed * 41 + 17 ) );
	const N = slotNormals( geometry, S );

	// Pits / bumps: centres at random surface points, power-law radii, each with its own depth and rim.
	const pits = [];
	if ( o.pits?.count ) {

		const pp = o.pits, [ rmin, rmax ] = pp.size ?? [ 0.03, 0.15 ];
		const pv = new THREE.Vector3(), nv = new THREE.Vector3();
		for ( let tries = 0; pits.length < pp.count && tries < pp.count * 20; tries ++ ) {

			const s = rng.int( S.count );
			pv.fromArray( P, s * 3 ); nv.fromArray( N, s * 3 );
			if ( pp.filter && ! pp.filter( pv, nv ) ) continue;
			const r = rng.power( rmin, rmax, 2.1 ), bump = rng.next() < ( pp.bumps ?? 0 );
			pits.push( { x: pv.x, y: pv.y, z: pv.z, r, reach2: ( r * 1.9 ) ** 2, bump,
				depth: r * ( pp.depth ?? 0.35 ) * rng.range( 0.75, 1.25 ), rimK: ( pp.rim ?? 0.4 ) * rng.range( 0.5, 1.2 ), rimW: rng.range( 0.45, 0.8 ), floor: rng.range( - 0.8, - 0.45 ) } );

		}

	}

	const grooves = ( o.grooves ?? [] ).map( ( g ) => ( { a: new THREE.Vector3( ...g.a ), b: new THREE.Vector3( ...g.b ), w: g.width, d: g.depth } ) );
	const cells = o.cells, cScale = cells?.scale ?? 4, cW = cells?.width ?? 0.12;
	const tmp = new THREE.Vector3(), ab = new THREE.Vector3(), ap = new THREE.Vector3();

	const H = new Float32Array( S.count );
	for ( let s = 0; s < S.count; s ++ ) {

		const px = P[ s * 3 ], py = P[ s * 3 + 1 ], pz = P[ s * 3 + 2 ];
		let x = px * sc[ 0 ], y = py * sc[ 1 ], z = pz * sc[ 2 ];
		if ( warp ) {

			const wx = noiseW( x * 0.5, y * 0.5, z * 0.5 ), wy = noiseW( x * 0.5 + 5.2, y * 0.5 + 1.3, z * 0.5 ), wz = noiseW( x * 0.5, y * 0.5 + 9.1, z * 0.5 + 2.7 );
			x += wx * warp * 2; y += wy * warp * 2; z += wz * warp * 2;

		}

		let h = 0;
		if ( amp ) {

			const f = fbm3( noise, x, y, z, fo ) * 1.6;
			const r = ridged > 0 ? ( ridged3( noiseB, x, y, z, { octaves: Math.max( 1, fo.octaves - 1 ), gain: fo.gain } ) - 0.45 ) * 2 : 0;
			h += amp * ( f * ( 1 - ridged ) + r * ridged );

		}

		if ( cells?.amount ) {

			const w = worley( x / sc[ 0 ] * cScale, y / sc[ 1 ] * cScale, z / sc[ 2 ] * cScale ); // warped coordinates
			const gap = w.f2 - w.f1;
			if ( cells.mode === 'plateaus' ) h += cells.amount * ( Math.sqrt( Math.min( 1, gap / cW ) ) * ( 0.6 + 0.4 * w.id ) - 0.5 );
			else if ( cells.mode === 'bumps' ) h += cells.amount * ( Math.pow( Math.max( 0, 1 - w.f1 * 1.3 ), 2 ) * ( 0.5 + w.id ) - 0.3 );
			else h -= cells.amount * ( 1 - smoothstep( 0, cW, gap ) );

		}

		for ( let i = 0; i < pits.length; i ++ ) {

			const c = pits[ i ];
			const dx = px - c.x, dy = py - c.y, dz = pz - c.z, d2 = dx * dx + dy * dy + dz * dz;
			if ( d2 > c.reach2 ) continue;
			const t = Math.sqrt( d2 ) / c.r;
			if ( c.bump ) {

				if ( t < 1 ) h += c.depth * ( 1 - t * t ) ** 2;
				continue;

			}

			const cavity = t * t - 1;
			const rimX = Math.min( t - 1 - c.rimW, 0 );
			h += smin( smax( cavity, c.floor, 0.3 ), c.rimK * rimX * rimX, 0.25 ) * c.depth;

		}

		for ( const g of grooves ) {

			ab.subVectors( g.b, g.a ); ap.set( px, py, pz ).sub( g.a );
			const t = clamp( ap.dot( ab ) / Math.max( 1e-12, ab.lengthSq() ) );
			const d = tmp.copy( g.a ).addScaledVector( ab, t ).distanceTo( ap.add( g.a ) );
			if ( d < g.w ) h -= g.d * ( 1 - ( d / g.w ) ** 2 ) ** 2;

		}

		H[ s ] = h;

	}

	const pos = geometry.attributes.position, n = pos.count, kh = new Float32Array( n );
	let lo = Infinity, hi = - Infinity;
	const moved = new Float32Array( S.count * 3 );
	for ( let s = 0; s < S.count; s ++ ) {

		let x = P[ s * 3 ] + N[ s * 3 ] * H[ s ], y = P[ s * 3 + 1 ] + N[ s * 3 + 1 ] * H[ s ], z = P[ s * 3 + 2 ] + N[ s * 3 + 2 ] * H[ s ];
		if ( o.base ) y = smax( y, o.base.y, o.base.soft ?? 0.02 );
		moved[ s * 3 ] = x; moved[ s * 3 + 1 ] = y; moved[ s * 3 + 2 ] = z;
		lo = Math.min( lo, H[ s ] ); hi = Math.max( hi, H[ s ] );

	}

	for ( let i = 0; i < n; i ++ ) {

		const s = S.slotOf[ i ];
		pos.setXYZ( i, moved[ s * 3 ], moved[ s * 3 + 1 ], moved[ s * 3 + 2 ] );
		kh[ i ] = amp ? H[ s ] / amp : H[ s ];

	}

	pos.needsUpdate = true;
	geometry.setAttribute( 'kitHeight', new THREE.BufferAttribute( kh, 1 ) );
	smoothNormals( geometry );
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	geometry.userData.displace = { min: lo, max: hi };
	return geometry;

}

// ---------------------------------------------------------------- vertex tint

/**
 * 顶点上色：基础色 × 噪声色斑，按置换高度在 low/high 之间过渡，凹处（缝、坑）偏 cavity 色，凸棱偏 edge 色（磨亮、积灰），
 * 朝上的面偏 top 色（烤色、苔藓、灰尘）。材质需 vertexColors: true（颜色乘到 material.color 上）。
 * Vertex tint: base × noise mottling, low/high by displacement height, cavity colour in concave spots, edge colour on
 * convex ridges (wear), top colour on up-facing areas (browning, moss, dust). Use with vertexColors: true.
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [o]
 * @param {THREE.ColorRepresentation} [o.color=0xffffff] 基础色 / base colour
 * @param {THREE.ColorRepresentation} [o.low] 置换最低处颜色 / colour at the lowest displacement
 * @param {THREE.ColorRepresentation} [o.high] 置换最高处颜色 / colour at the highest displacement
 * @param {{color?:THREE.ColorRepresentation, amount?:number}} [o.cavity] 凹处（默认黑色 × 0.5）/ concave tint
 * @param {{color?:THREE.ColorRepresentation, amount?:number}} [o.edge] 凸棱（默认白色 × 0.25）/ convex tint
 * @param {{color:THREE.ColorRepresentation, amount?:number, sharpness?:number, axis?:number[]}} [o.top] 朝向 axis（默认 +y）的面 / facing tint
 * @param {{amount?:number, scale?:number, seed?:number}} [o.noise] 色斑（默认 0.15，每单位 3 个）/ mottling
 * 三角形 / triangles: 不变 / unchanged.
 */
export function vertexTint( geometry, o = {} ) {

	const S = positionSlots( geometry ), P = S.pos;
	if ( o.facets?.count ) cutFacets( S, o.facets, makeRng( seed * 41 + 17 ) );
	const N = slotNormals( geometry, S );
	// Curvature per slot: mean of (neighbour − p)·n / |neighbour − p| over edges (positive = concave).
	const cs = new Float32Array( S.count ), cn = new Float32Array( S.count );
	const edge = ( a, b ) => {

		const dx = P[ b * 3 ] - P[ a * 3 ], dy = P[ b * 3 + 1 ] - P[ a * 3 + 1 ], dz = P[ b * 3 + 2 ] - P[ a * 3 + 2 ];
		const l = Math.hypot( dx, dy, dz ) || 1;
		cs[ a ] += ( dx * N[ a * 3 ] + dy * N[ a * 3 + 1 ] + dz * N[ a * 3 + 2 ] ) / l; cn[ a ] ++;
		cs[ b ] -= ( dx * N[ b * 3 ] + dy * N[ b * 3 + 1 ] + dz * N[ b * 3 + 2 ] ) / l; cn[ b ] ++;

	};

	const edges = [];
	forTriangles( geometry, ( a, b, c ) => {

		a = S.slotOf[ a ]; b = S.slotOf[ b ]; c = S.slotOf[ c ];
		edge( a, b ); edge( b, c ); edge( c, a );
		edges.push( a, b, b, c, c, a );

	} );
	let curv = new Float32Array( S.count );
	for ( let s = 0; s < S.count; s ++ ) curv[ s ] = cn[ s ] ? cs[ s ] / cn[ s ] : 0;
	// One smoothing pass, then scale so ±2 standard deviations map to ±1.
	const sm = new Float32Array( S.count ), sn = new Float32Array( S.count );
	for ( let i = 0; i < edges.length; i += 2 ) {

		sm[ edges[ i ] ] += curv[ edges[ i + 1 ] ]; sn[ edges[ i ] ] ++;

	}

	let v2 = 0;
	for ( let s = 0; s < S.count; s ++ ) {

		curv[ s ] = 0.5 * curv[ s ] + 0.5 * ( sn[ s ] ? sm[ s ] / sn[ s ] : curv[ s ] );
		v2 += curv[ s ] * curv[ s ];

	}

	const k = 1 / ( 2 * Math.sqrt( v2 / Math.max( 1, S.count ) ) + 1e-6 );
	curv = curv.map( ( c ) => clamp( c * k, - 1, 1 ) );

	const base = new THREE.Color( o.color ?? 0xffffff );
	const lo = o.low !== undefined ? new THREE.Color( o.low ) : null, hi = o.high !== undefined ? new THREE.Color( o.high ) : null;
	const cav = new THREE.Color( o.cavity?.color ?? 0x000000 ), cavA = o.cavity?.amount ?? 0.5;
	const edg = new THREE.Color( o.edge?.color ?? 0xffffff ), edgA = o.edge?.amount ?? 0.25;
	const top = o.top ? new THREE.Color( o.top.color ) : null, topA = o.top?.amount ?? 0.6, topS = o.top?.sharpness ?? 2;
	const axis = new THREE.Vector3( ...( o.top?.axis ?? [ 0, 1, 0 ] ) ).normalize();
	const nz = makeNoise3( ( o.noise?.seed ?? 3 ) * 11 + 7 ), nA = o.noise?.amount ?? 0.15, nS = o.noise?.scale ?? 3;
	const kh = geometry.attributes.kitHeight;
	let hmin = Infinity, hmax = - Infinity;
	if ( kh ) for ( let i = 0; i < kh.count; i ++ ) {

		hmin = Math.min( hmin, kh.getX( i ) ); hmax = Math.max( hmax, kh.getX( i ) );

	}

	const n = geometry.attributes.position.count, col = new Float32Array( n * 3 ), c = new THREE.Color();
	for ( let i = 0; i < n; i ++ ) {

		const s = S.slotOf[ i ], x = P[ s * 3 ], y = P[ s * 3 + 1 ], z = P[ s * 3 + 2 ];
		c.copy( base );
		if ( lo && hi && kh ) c.copy( lo ).lerp( hi, ( kh.getX( i ) - hmin ) / Math.max( 1e-6, hmax - hmin ) ).multiply( base );
		if ( top ) {

			const f = Math.pow( clamp( N[ s * 3 ] * axis.x + N[ s * 3 + 1 ] * axis.y + N[ s * 3 + 2 ] * axis.z ), topS );
			c.lerp( top, f * topA );

		}

		const m = 1 + nA * fbm3( nz, x * nS, y * nS, z * nS, { octaves: 3 } ) * 1.5;
		c.multiplyScalar( Math.max( 0, m ) );
		const cv = curv[ s ];
		if ( cv > 0 ) c.lerp( cav, clamp( cv * cavA ) ); else c.lerp( edg, clamp( - cv * edgA ) );
		col[ i * 3 ] = c.r; col[ i * 3 + 1 ] = c.g; col[ i * 3 + 2 ] = c.b;

	}

	geometry.setAttribute( 'color', new THREE.BufferAttribute( col, 3 ) );
	return geometry;

}

// ---------------------------------------------------------------- tileable detail maps

/**
 * 可平铺细节贴图生成器：同一组参数得到配套的法线贴图、粗糙度贴图和明暗色斑贴图（都无缝）。
 * Tileable detail maps: one parameter set gives a matching normal map, roughness map and tint map (all seamless).
 * 层（都可选，振幅相对）/ layers (all optional, relative amplitudes):
 *   fbm {amp, period:[px,py], octaves, gain}；ridged {amp, period, octaves}（脊/沟，period 拉长 = 竖沟）；
 *   cells {amp, period, mode:'cracks'|'plateaus'|'bumps'|'pores', width}；cells2 第二层胞格；
 *   pits {count, size:[min,max]（贴图比例），depth, rim}（小坑，bumps>0 时部分为鼓包）；grain {amp, period}（细颗粒/斑点）
 * @param {string|object} [kind='rock'] SURFACE_RECIPES 的名字或参数对象 / a recipe name or a maps parameter object
 * @param {object} [o] 覆盖参数：size（默认 512，≤1024）、seed、strength（法线强度）、roughness {base, range, invert}、tint {low, high, cavity}
 * @returns {{packed:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture, map:THREE.Texture, height:{data:Float32Array,width:number,height:number}}}
 *   packed 打包贴图（法线 xy + 粗糙度 + 明暗，给 triplanarDetail 用，最快）；normalMap / roughnessMap / map 为按 UV 使用的分开贴图（首次访问时才生成），
 *   map 是乘到材质颜色上的 sRGB 明暗/色斑；全部 RepeatWrapping、缓存（相同参数只生成一次）
 *   / packed: normal xy + roughness + brightness for triplanarDetail (fastest); separate UV maps are built on first access;
 *   map is an sRGB multiplier for material.color; all repeating and cached per parameter set
 * 开销 / cost: 512² 约 0.2–0.6 s（一次，sceneReady 里）；1024² 约 4 倍 / 512² ≈ 0.2–0.6 s once; 1024² ≈ 4×.
 */
export function surfaceMaps( kind = 'rock', o = {} ) {

	const base = typeof kind === 'string' ? ( SURFACE_RECIPES[ kind ]?.maps ?? SURFACE_RECIPES.rock.maps ) : kind;
	const p = { ...base, ...o };
	const size = texSize( p.size ?? 512 ), seed = p.seed ?? 1;
	return cached( 'surfaceMaps:' + JSON.stringify( { ...p, size, seed } ), () => {

		const n2 = makeNoise2Periodic( seed * 17 + 3 ), n2b = makeNoise2Periodic( seed * 29 + 11 );
		const w2 = makeWorley2Periodic( seed * 5 + 1 ), w2b = makeWorley2Periodic( seed * 7 + 9 );
		const per = ( q, d ) => ( Array.isArray( q ) ? q : [ q ?? d, q ?? d ] );
		const cellLayer = ( c, w, u, v ) => {

			if ( ! c?.amp ) return 0;
			const [ px, py ] = per( c.period, 8 ), cw = c.width ?? 0.12;
			const r = w( u, v, px, py ), gap = r.f2 - r.f1;
			switch ( c.mode ) {

				case 'plateaus': return c.amp * ( Math.sqrt( Math.min( 1, gap / cw ) ) * ( 0.6 + 0.4 * r.id ) );
				case 'bumps': return c.amp * Math.pow( Math.max( 0, 1 - r.f1 * 1.25 ), 1.6 ) * ( 0.55 + 0.45 * r.id );
				case 'pores': return - c.amp * smoothstep( cw, 0, r.f1 ) * ( r.id > 0.4 ? 1 : 0 );
				default: return - c.amp * ( 1 - smoothstep( 0, cw, gap ) );

			}

		};

		const H = heightField( size, size, ( u, v ) => {

			let h = 0;
			if ( p.fbm?.amp ) {

				const [ px, py ] = per( p.fbm.period, 4 );
				h += p.fbm.amp * fbm2PeriodicXY( n2, u, v, px, py, p.fbm.octaves ?? 6, p.fbm.gain ?? 0.5 );

			}

			if ( p.ridged?.amp ) {

				const [ px, py ] = per( p.ridged.period, 4 );
				h += p.ridged.amp * ( fbm2PeriodicXY( n2b, u, v, px, py, p.ridged.octaves ?? 4, p.ridged.gain ?? 0.5, true ) - 0.5 );

			}

			h += cellLayer( p.cells, w2, u, v ) + cellLayer( p.cells2, w2b, u, v );
			if ( p.grain?.amp ) {

				const [ px, py ] = per( p.grain.period, 96 );
				h += p.grain.amp * n2b( u * px + 0.5, v * py + 0.5, px, py );

			}

			return h;

		} );

		// Pits / bumps stamped into their bounding boxes (wrapping), so many small pits stay cheap.
		if ( p.pits?.count ) {

			const rng = makeRng( seed * 3 + 1 ), [ rmin, rmax ] = p.pits.size ?? [ 0.004, 0.03 ], D = H.data;
			for ( let i = 0; i < p.pits.count; i ++ ) {

				const cx = rng.next() * size, cy = rng.next() * size, r = rng.power( rmin, rmax, 2.2 ) * size;
				const bump = rng.next() < ( p.pits.bumps ?? 0 ), depth = ( p.pits.depth ?? 1 ) * rng.range( 0.6, 1.3 ) * ( r / size ) * 10;
				const rimK = p.pits.rim ?? 0.3, reach = Math.ceil( r * 1.7 );
				for ( let y = - reach; y <= reach; y ++ ) for ( let x = - reach; x <= reach; x ++ ) {

					const t = Math.hypot( x + ( cx % 1 ), y + ( cy % 1 ) ) / r;
					if ( t > 1.7 ) continue;
					const X = ( ( Math.floor( cx ) + x ) % size + size ) % size, Y = ( ( Math.floor( cy ) + y ) % size + size ) % size;
					const v = bump ? ( t < 1 ? ( 1 - t * t ) ** 2 : 0 ) : smin( smax( t * t - 1, - 0.7, 0.3 ), rimK * Math.min( t - 1.6, 0 ) ** 2, 0.3 );
					D[ Y * size + X ] += v * depth;

				}

			}

		}

		normalizeField( H );
		const strength = ( p.strength ?? 4 ) * size / 512;
		const ro = p.roughness ?? {}, rBase = ro.base ?? 0.7, rRange = ro.range ?? 0.25, rSign = ro.invert ? 1 : - 1;
		const ti = p.tint ?? {}, lowL = new THREE.Color( ti.low ?? 0xd8d8d8 ), hiL = new THREE.Color( ti.high ?? 0xffffff ), cav = ti.cavity ?? 0.35;
		const lum = ( c ) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, l0 = lum( lowL ), l1 = lum( hiL ), lmax = Math.max( l0, l1, 1e-6 );
		const packed = packDetailTexture( H, {
			strength,
			roughness: ( h ) => rBase + rSign * rRange * ( h - 0.5 ) * 2,
			tint: ( h ) => ( l0 + ( l1 - l0 ) * h ) / lmax * ( 1 - cav * ( 1 - h ) * ( 1 - h ) ),
		} );
		// Separate maps (for UV-mapped use) are built on first access only.
		const lazy = {};
		const out = { packed, height: H };
		for ( const [ k, make ] of Object.entries( {
			normalMap: () => heightToNormalMap( H, { strength } ),
			roughnessMap: () => roughnessFromHeight( H, ro ),
			map: () => tintFromHeight( H, ti ),
		} ) ) Object.defineProperty( out, k, { enumerable: true, get: () => ( lazy[ k ] ??= make() ) } );
		return out;

	} );

}

// ---------------------------------------------------------------- recipes

/**
 * 表面配方：置换参数 + 细节贴图参数 + 顶点上色 + 材质参数。全部是参数，可整体覆盖。
 * Surface recipes: displacement + detail-map + tint + material parameters. Plain data: override any part.
 * displace.amplitude 等以“物体约 1 单位大小”为准，物体更大/更小时按比例传 amplitude 与 scale（或用 detailSurface 的 size）。
 * Displacement values assume an object about 1 unit across; detailSurface scales them by `size`.
 */
export const SURFACE_RECIPES = {
	// 粗糙岩石：脊 + 裂缝 + 小坑 / rough rock: ridges, joint cracks, chips
	rock: {
		displace: { amplitude: 0.06, scale: 1.5, octaves: 4, ridged: 0.25, warp: 0.35, facets: { count: 12, depth: 0.3, soft: 0.03 }, pits: { count: 14, size: [ 0.02, 0.07 ], depth: 0.3, rim: 0.15 } },
		maps: { fbm: { amp: 1, period: 4, octaves: 6 }, ridged: { amp: 0.3, period: 3 }, cells: { amp: 0.1, period: 5, mode: 'cracks', width: 0.03 }, pits: { count: 80, size: [ 0.003, 0.015 ] }, grain: { amp: 0.3, period: 160 }, strength: 5, roughness: { base: 0.85, range: 0.12 }, tint: { low: 0xd2cdc6, high: 0xffffff, cavity: 0.3 } },
		tint: { color: 0x6f6a63, cavity: { color: 0x26221f, amount: 0.5 }, edge: { color: 0xa9a399, amount: 0.25 }, noise: { amount: 0.15, scale: 2 } },
		material: { roughness: 1, metalness: 0 }, detail: { scale: 3.5, strength: 1.1, tint: 0.7 },
	},
	// 河卵石/光滑石头：低起伏 + 斑点 / smooth stone or pebble: gentle relief, speckles
	stone: {
		displace: { amplitude: 0.025, scale: 1.3, octaves: 3, warp: 0.2 },
		maps: { fbm: { amp: 0.6, period: 3, octaves: 5 }, cells: { amp: 0.12, period: 24, mode: 'bumps' }, pits: { count: 140, size: [ 0.002, 0.008 ], depth: 0.6 }, grain: { amp: 0.35, period: 160 }, strength: 2.5, roughness: { base: 0.62, range: 0.18 }, tint: { low: 0xb9b4ac, high: 0xffffff, cavity: 0.3 } },
		tint: { color: 0x8a847b, cavity: { color: 0x3a3631, amount: 0.3 }, edge: { color: 0xd8d2c8, amount: 0.2 }, noise: { amount: 0.28, scale: 4 } },
		material: { roughness: 1, metalness: 0 }, detail: { scale: 3, strength: 0.8 },
	},
	// 树皮：竖向脊沟 + 横向裂纹（几何用于圆柱/车削体，y 为生长方向）/ bark: vertical furrows and cross cracks (y = trunk axis)
	bark: {
		displace: { amplitude: 0.045, scale: [ 9, 1.1, 9 ], octaves: 4, ridged: 0.85, warp: 0.25 },
		maps: { ridged: { amp: 1, period: [ 10, 2 ], octaves: 4 }, fbm: { amp: 0.35, period: [ 6, 3 ] }, cells: { amp: 0.4, period: [ 8, 3 ], mode: 'cracks', width: 0.08 }, grain: { amp: 0.1, period: [ 64, 16 ] }, strength: 7, roughness: { base: 0.88, range: 0.1 }, tint: { low: 0x6a5a4c, high: 0xffffff, cavity: 0.6 } },
		tint: { color: 0x7a6553, cavity: { color: 0x1e1712, amount: 0.75 }, edge: { color: 0xa89888, amount: 0.3 }, noise: { amount: 0.18, scale: 2 } },
		material: { roughness: 1, metalness: 0 }, detail: { scale: 3, strength: 1.2 },
	},
	// 面包皮：气泡鼓包 + 细孔 + 撒粉色斑（朝上更焦）/ bread crust: blisters, pores, flour mottling (browner on top)
	crust: {
		displace: { amplitude: 0.018, scale: 3, octaves: 4, warp: 0.4, cells: { amount: 0.012, scale: 6, mode: 'bumps' }, pits: { count: 40, size: [ 0.01, 0.035 ], depth: 0.4, rim: 0.1, bumps: 0.5 } },
		maps: { cells: { amp: 0.7, period: 10, mode: 'bumps' }, cells2: { amp: 0.25, period: 22, mode: 'pores', width: 0.22 }, fbm: { amp: 0.35, period: 5 }, pits: { count: 220, size: [ 0.002, 0.009 ], depth: 0.8 }, grain: { amp: 0.15, period: 128 }, strength: 4, roughness: { base: 0.72, range: 0.15, invert: true }, tint: { low: 0xe2d6c6, high: 0xffffff, cavity: 0.12 } },
		tint: { color: 0xb87a40, low: 0xa86a35, high: 0xffffff, top: { color: 0x5a2a0c, amount: 0.8, sharpness: 1.2 }, cavity: { color: 0xead0a0, amount: 0.45 }, edge: { color: 0x41200a, amount: 0.5 }, noise: { amount: 0.2, scale: 5 } },
		material: { roughness: 1, metalness: 0 }, detail: { scale: 4, strength: 0.9 },
	},
	// 陶土/黏土：柔和起伏 + 指纹般的细纹 + 小气孔 / clay: soft relief, fine drag lines, small air pits
	clay: {
		displace: { amplitude: 0.012, scale: 2.2, octaves: 3, warp: 0.5 },
		maps: { fbm: { amp: 0.5, period: 3, octaves: 5 }, ridged: { amp: 0.25, period: [ 2, 28 ], octaves: 2 }, pits: { count: 70, size: [ 0.002, 0.007 ], depth: 0.8 }, grain: { amp: 0.08, period: 192 }, strength: 2.5, roughness: { base: 0.8, range: 0.1 }, tint: { low: 0xd6cfc6, high: 0xffffff, cavity: 0.2 } },
		tint: { color: 0xb5714d, cavity: { color: 0x5e3420, amount: 0.3 }, edge: { color: 0xd8a383, amount: 0.15 }, noise: { amount: 0.12, scale: 3 } },
		material: { roughness: 1, metalness: 0 }, detail: { scale: 3, strength: 0.8 },
	},
	// 地形：脊状山 + 域扭曲 + 侵蚀沟（PlaneGeometry 转水平后置换，法线朝上）/ terrain: ridged, warped, eroded (on a horizontal plane)
	terrain: {
		displace: { amplitude: 0.22, scale: 1.4, octaves: 6, ridged: 0.75, warp: 0.4 },
		maps: { ridged: { amp: 0.6, period: 4, octaves: 4 }, fbm: { amp: 0.5, period: 6 }, grain: { amp: 0.06, period: 96 }, strength: 3, roughness: { base: 0.92, range: 0.05 }, tint: { low: 0xd6d2c8, high: 0xffffff, cavity: 0.2 } },
		tint: { color: 0xffffff, low: 0x46552c, high: 0x7d7366, top: { color: 0x5f6e36, amount: 0.5, sharpness: 6 }, cavity: { color: 0x2c2a22, amount: 0.45 }, edge: { color: 0xb3ab9e, amount: 0.15 }, noise: { amount: 0.1, scale: 2 } },
		material: { roughness: 1, metalness: 0 }, detail: { scale: 2, strength: 0.8 },
	},
};

/**
 * 一步到位：几何体 → 置换 → 顶点上色 → 三平面细节材质 → Mesh。
 * One call: geometry → displace → vertex tint → triplanar-detail material → Mesh.
 * @param {THREE.BufferGeometry} geometry 足够致密的基础形（icosphere / superEllipsoid / subdivide）/ a dense base shape
 * @param {string|object} [recipe='rock'] SURFACE_RECIPES 的名字或同结构对象 / a recipe name or object
 * @param {{seed?:number, size?:number, displace?:object, maps?:object, tint?:object, material?:object, detail?:object}} [o]
 *   size：物体大致尺寸（世界单位，默认 1），置换幅度与频率按它缩放；其余键浅合并覆盖配方的同名部分
 *   / size: rough object size (default 1) that scales displacement; other keys shallow-merge over the recipe
 * 三角形 / triangles: 与输入几何相同 / same as the input geometry. 贴图 / textures: 1 张 512² 打包贴图（缓存）/ one packed 512² texture (cached).
 * @returns {THREE.Mesh} userData.triangles
 */
export function detailSurface( geometry, recipe = 'rock', o = {} ) {

	const R = typeof recipe === 'string' ? SURFACE_RECIPES[ recipe ] ?? SURFACE_RECIPES.rock : recipe;
	const size = o.size ?? 1, seed = o.seed ?? 1;
	const d = { ...R.displace, ...o.displace, seed };
	if ( size !== 1 ) {

		d.amplitude = ( d.amplitude ?? 0.08 ) * size;
		d.scale = Array.isArray( d.scale ) ? d.scale.map( ( s ) => s / size ) : ( d.scale ?? 2 ) / size;
		if ( d.cells ) d.cells = { ...d.cells, amount: d.cells.amount * size, scale: ( d.cells.scale ?? 4 ) / size };
		if ( d.pits ) d.pits = { ...d.pits, size: ( d.pits.size ?? [ 0.03, 0.15 ] ).map( ( s ) => s * size ) };

	}

	displace( geometry, d );
	vertexTint( geometry, { ...R.tint, ...o.tint, noise: { ...R.tint?.noise, ...o.tint?.noise, scale: ( o.tint?.noise?.scale ?? R.tint?.noise?.scale ?? 3 ) / size, seed } } );
	const mat = new THREE.MeshStandardMaterial( { color: 0xffffff, vertexColors: true, ...R.material, ...o.material } );
	const maps = surfaceMaps( { ...R.maps, ...o.maps } );
	const det = { ...R.detail, ...o.detail };
	triplanarDetail( mat, { packed: maps.packed, scale: ( det.scale ?? 2 ) / size, strength: det.strength ?? 1, fine: det.fine, cavity: det.cavity, roughness: det.roughness, tint: det.tint } );
	const mesh = new THREE.Mesh( geometry, mat );
	mesh.userData.triangles = ( geometry.index ? geometry.index.count : geometry.attributes.position.count ) / 3;
	return mesh;

}
