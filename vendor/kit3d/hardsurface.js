// Hard-surface detail for manufactured objects: rounded boxes and cylinders, panel seams and grooves (object-space
// shader lines, or normal maps from a UV layout), instanced bolts/screws/rivets, cables and hoses with sag, straps,
// instances along a curve (zipper teeth, stitches, chain), perforated grilles and louvred vents.
// 硬表面细节：圆角盒/圆角柱、面板缝与沟槽（物体空间着色器线，或 UV 布局生成的法线贴图）、实例化螺丝/铆钉、带下垂的线缆/软管、
// 带子、沿曲线排布的实例（拉链齿、缝线、链条）、穿孔网罩与百叶通风口。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, makeNoise3 } from './noise.js';
import { cached, makeCanvas, canvasToHeight, blurField, heightToNormalMap, fieldToDataTexture, colorTexture, dataTexture, paintCanvas, boxProjectUVs, texSize } from './textures.js';
import { patchObjectSpace } from './shader.js';

const V = ( a ) => ( a?.isVector3 ? a.clone() : new THREE.Vector3( ...( a ?? [ 0, 0, 0 ] ) ) );
const tris = ( g ) => ( g.index ? g.index.count : g.attributes.position.count ) / 3;
const f = ( x ) => Number( x ).toFixed( 5 );
const vec = ( a ) => `vec3(${f( a.x )},${f( a.y )},${f( a.z )})`;

// ---------------------------------------------------------------- rounded primitives

/**
 * 圆角盒（three 的 RoundedBoxGeometry）：倒角棱会接住高光，比直角盒真实得多。
 * Rounded box (three's RoundedBoxGeometry): bevelled edges catch highlights, the cheapest realism win.
 * @param {number} w @param {number} h @param {number} d 尺寸 / size
 * @param {{radius?:number, segments?:number, uvTile?:number}} [o] radius 圆角半径（默认最短边 8%）；segments 圆角段数（默认 4）；
 *   uvTile>0 时改为世界单位盒式 UV（每 uvTile 单位平铺一次）/ radius (8% of the shortest side); segments (4); uvTile: world-unit box UVs
 * 三角形 / triangles: segments 2 → 300，4 → 972，5 → 1,452，6 → 2,028（与尺寸无关）/ independent of size.
 * @returns {THREE.BufferGeometry}
 */
export function roundedBox( w, h, d, o = {} ) {

	const r = Math.min( o.radius ?? Math.min( w, h, d ) * 0.08, Math.min( w, h, d ) / 2 - 1e-4 );
	const g = new RoundedBoxGeometry( w, h, d, o.segments ?? 4, r );
	if ( o.uvTile ) boxProjectUVs( g, o.uvTile );
	return g;

}

/**
 * 圆角圆柱（车削轮廓，上下棱倒圆）：旋钮、镜筒、瓶盖、按钮、轮子。
 * Rounded cylinder from a lathe profile with filleted rims: knobs, barrels, caps, buttons, wheels.
 * @param {number} radius 底半径 / bottom radius
 * @param {number} height 高（沿 y，居中）/ height along y, centred
 * @param {{radiusTop?:number, bevel?:number, bevelSegments?:number, radial?:number, open?:boolean}} [o]
 *   radiusTop 顶半径（默认同 radius）；bevel 倒角半径（默认 min(r,h) 的 12%）；bevelSegments（默认 4）；radial 圆周段数（默认 48）；
 *   open 不封顶底 / no caps
 * 三角形 / triangles: radial·(2·bevelSegments+3)·2（默认 48 → 1,056）。UV：u 绕圈，v 沿轮廓。
 * @returns {THREE.BufferGeometry}
 */
export function roundedCylinder( radius, height, o = {} ) {

	const rt = o.radiusTop ?? radius, b = Math.min( o.bevel ?? Math.min( radius, rt, height ) * 0.12, height / 2 - 1e-4, Math.min( radius, rt ) - 1e-4 );
	const n = o.bevelSegments ?? 4, pts = [], hy = height / 2;
	if ( ! o.open ) pts.push( new THREE.Vector2( 0, - hy ) );
	for ( let i = 0; i <= n; i ++ ) {

		const a = - Math.PI / 2 + ( i / n ) * Math.PI / 2;
		pts.push( new THREE.Vector2( radius - b + Math.cos( a ) * b, - hy + b + Math.sin( a ) * b ) );

	}

	for ( let i = 0; i <= n; i ++ ) {

		const a = ( i / n ) * Math.PI / 2;
		pts.push( new THREE.Vector2( rt - b + Math.cos( a ) * b, hy - b + Math.sin( a ) * b ) );

	}

	if ( ! o.open ) pts.push( new THREE.Vector2( 0, hy ) );
	const g = new THREE.LatheGeometry( pts, o.radial ?? 48 );
	g.computeVertexNormals();
	return g;

}

// ---------------------------------------------------------------- seams (object-space shader)

/**
 * 面板缝/沟槽/凸筋：在材质上叠加物体空间的解析线条，法线两侧倾斜（一侧接光发亮、一侧暗），缝底压暗、变粗糙。
 * 线宽按像素自动加宽到约 1.2 像素，480p 下不闪不断。不需要 UV，可与 normalMap、三平面细节等叠加。
 * Panel seams / grooves / raised ribs as analytic object-space lines on a material: the walls tilt the normal (one side
 * catches the light, the other goes dark), the bottom is darker and rougher. Width is widened to ≥ ~1.2 px so lines
 * neither shimmer nor break up at 480p. No UVs; stacks with normal maps and other patches.
 *
 * 布局项 / layout items (object space of the mesh using the material; all numbers in world units):
 *   { type:'plane', normal:[x,y,z], offset }               分模线：表面与平面 dot(p,n)=offset 的交线 / parting line around the body
 *   { type:'rect', center, normal, up, size:[w,h], radius } 面上的圆角矩形面板（只作用在朝 normal 的面上）/ rounded panel on a face
 *   { type:'circle', center, normal, radius }              圆圈（按钮、盖子、螺丝孔周围）/ ring on a face
 *   { type:'line', a, b, normal }                          线段 / segment on a face
 *   每项可选 / per item: width（半宽，默认 o.width）、slope（倾斜，负数为凸筋）、dark（压暗 0..1）、slab（离面板平面多远仍生效）
 * @param {THREE.MeshStandardMaterial} material 会被修改 / modified
 * @param {object[]} items
 * @param {{width?:number, slope?:number, dark?:number}} [o] width 默认半宽（默认 0.004）；slope 默认 1.6；dark 默认 0.55
 * 开销 / cost: 无三角形；每像素每项十几条指令 / no triangles; a dozen instructions per item per pixel.
 * @returns {THREE.MeshStandardMaterial}
 */
export function seams( material, items, o = {} ) {

	const W0 = o.width ?? 0.004, S0 = o.slope ?? 1.6, D0 = o.dark ?? 0.55;
	let code = '\t\tfloat kPix = max( length( fwidth( kitP ) ), 1e-6 );\n\t\tfloat kBest = 1e9; vec3 kG = vec3( 0.0 ); float kS = 0.0, kD = 0.0;\n';
	for ( const it of items ) {

		const W = it.width ?? W0, S = it.slope ?? S0, D = it.dark ?? D0;
		const n = V( it.normal ?? [ 0, 1, 0 ] ).normalize();
		let body = '';
		if ( it.type === 'plane' ) {

			body = `float d = dot( kitP, ${vec( n )} ) - ${f( it.offset ?? 0 )}; vec3 g = ${vec( n )}; float m = 1.0;`;

		} else {

			const c = V( it.center ?? it.a ?? [ 0, 0, 0 ] );
			const up = V( it.up ?? ( Math.abs( n.y ) > 0.9 ? [ 0, 0, - 1 ] : [ 0, 1, 0 ] ) );
			const u = new THREE.Vector3().crossVectors( up, n ).normalize(), vv = new THREE.Vector3().crossVectors( n, u );
			const slab = it.slab ?? 1e3;
			body = `vec3 q = kitP - ${vec( c )}; float m = smoothstep( 0.2, 0.45, dot( kitN, ${vec( n )} ) ) * step( abs( dot( q, ${vec( n )} ) ), ${f( slab )} ); float d; vec3 g;`;
			if ( it.type === 'rect' ) {

				const [ w, h ] = it.size ?? [ 0.2, 0.1 ], r = Math.min( it.radius ?? 0, w / 2, h / 2 );
				body += `
			vec2 q2 = vec2( dot( q, ${vec( u )} ), dot( q, ${vec( vv )} ) );
			vec2 dq = abs( q2 ) - vec2( ${f( w / 2 - r )}, ${f( h / 2 - r )} );
			vec2 g2;
			if ( max( dq.x, dq.y ) > 0.0 ) { vec2 mq = max( dq, 0.0 ); d = length( mq ) - ${f( r )}; g2 = normalize( mq + 1e-7 ) * sign( q2 ); }
			else { d = max( dq.x, dq.y ) - ${f( r )}; g2 = dq.x > dq.y ? vec2( sign( q2.x ), 0.0 ) : vec2( 0.0, sign( q2.y ) ); }
			g = g2.x * ${vec( u )} + g2.y * ${vec( vv )};`;

			} else if ( it.type === 'circle' ) {

				body += `
			vec2 q2 = vec2( dot( q, ${vec( u )} ), dot( q, ${vec( vv )} ) );
			float l = max( length( q2 ), 1e-7 ); d = l - ${f( it.radius ?? 0.05 )}; g = ( q2.x * ${vec( u )} + q2.y * ${vec( vv )} ) / l;`;

			} else {

				const a = V( it.a ), b = V( it.b ), ab = b.clone().sub( a );
				body += `
			vec3 pa = kitP - ${vec( a )}; float h = clamp( dot( pa, ${vec( ab )} ) / ${f( Math.max( 1e-9, ab.lengthSq() ) )}, 0.0, 1.0 );
			vec3 w3 = pa - ${vec( ab )} * h; w3 -= dot( w3, ${vec( n )} ) * ${vec( n )};
			d = max( length( w3 ), 1e-7 ); g = w3 / d;`;

			}

		}

		code += `\t\t{\n\t\t\t${body}\n\t\t\tfloat w = max( ${f( W )}, kPix * 1.2 );\n\t\t\tfloat x = abs( d ) / w / max( m, 1e-3 );\n\t\t\tif ( x < kBest ) { kBest = x; kG = sign( d ) * g; kS = ${f( S )} * min( 1.0, ${f( W )} / w * 1.5 ); kD = ${f( D )}; }\n\t\t}\n`;

	}

	code += `
		if ( kBest < 1.0 ) {
			float x = kBest, prof = ( 1.0 - x * x ) * ( 1.0 - x * x );
			vec3 G = kG * kS * 4.0 * x * ( 1.0 - x * x ) / 1.54;
			kitNp = normalize( kitNp - ( G - dot( G, kitNp ) * kitNp ) );
			diffuseColor.rgb *= 1.0 - kD * prof * step( 0.0, kS );
			kitRoughMul *= 1.0 + 0.3 * prof;
		}`;
	return patchObjectSpace( material, { surface: code } );

}

/**
 * UV 布局 → 沟槽法线贴图 + 缝底暗色贴图（用于有规整 UV 的平板、盒子的面）。坐标是 UV（0..1，v 向上）。
 * UV layout → groove normal map + cavity map, for plates and box faces with tidy UVs. Coordinates in UV (0..1, v up).
 * @param {{size?:number, width?:number, lines?:number[][], rects?:number[][], circles?:number[][], strength?:number, raised?:boolean}} o
 *   lines [[u0,v0,u1,v1]]；rects [[u,v,w,h,radius]]（u,v 为左下角）；circles [[u,v,r]]；width 线宽（UV 单位，默认 0.004）；
 *   size 贴图边长（默认 1024）；strength 法线强度（默认 6）；raised 凸筋而不是凹缝
 * @returns {{normalMap:THREE.Texture, aoMap:THREE.Texture, map:THREE.Texture}} map 为乘色（缝里暗）；不平铺 / map multiplies colour; not repeating
 */
export function grooveMaps( o = {} ) {

	const size = texSize( o.size ?? 1024 );
	return cached( 'grooves:' + JSON.stringify( { ...o, size } ), () => {

		const c = makeCanvas( size ), g = c.getContext( '2d' );
		g.fillStyle = '#fff'; g.fillRect( 0, 0, size, size );
		g.strokeStyle = '#000'; g.lineCap = 'round'; g.lineJoin = 'round';
		g.lineWidth = Math.max( 1.5, ( o.width ?? 0.004 ) * size * 2 );
		const X = ( u ) => u * size, Y = ( v ) => ( 1 - v ) * size;
		for ( const [ u0, v0, u1, v1 ] of o.lines ?? [] ) {

			g.beginPath(); g.moveTo( X( u0 ), Y( v0 ) ); g.lineTo( X( u1 ), Y( v1 ) ); g.stroke();

		}

		for ( const [ u, v, w, h, r = 0 ] of o.rects ?? [] ) {

			g.beginPath(); g.roundRect( X( u ), Y( v + h ), w * size, h * size, r * size ); g.stroke();

		}

		for ( const [ u, v, r ] of o.circles ?? [] ) {

			g.beginPath(); g.arc( X( u ), Y( v ), r * size, 0, Math.PI * 2 ); g.stroke();

		}

		let H = canvasToHeight( c );
		H = blurField( H, Math.max( 1, g.lineWidth * 0.35 ), { wrap: false } );
		if ( o.raised ) for ( let i = 0; i < H.data.length; i ++ ) H.data[ i ] = 1 - H.data[ i ];
		const normalMap = heightToNormalMap( H, { strength: ( o.strength ?? 6 ) * size / 1024, wrap: false, repeat: false } );
		const aoMap = fieldToDataTexture( H, ( h ) => 0.35 + 0.65 * h, { repeat: false } );
		const cc = paintCanvas( size, size, ( x, y, i, out ) => {

			out[ 0 ] = out[ 1 ] = out[ 2 ] = 255 * Math.pow( o.raised ? 1 : 0.3 + 0.7 * H.data[ i ], 1 / 2.2 );

		} );
		return { normalMap, aoMap, map: colorTexture( cc, { repeat: false } ) };

	} );

}

// ---------------------------------------------------------------- bolts / screws / rivets

const BOLT_PROFILES = {
	// [r, y] in head-radius units
	pan: [ [ 0, 0 ], [ 1, 0 ], [ 1, 0.12 ], [ 0.95, 0.3 ], [ 0.78, 0.42 ], [ 0.42, 0.49 ], [ 0, 0.5 ] ],
	socket: [ [ 0, 0 ], [ 0.95, 0 ], [ 0.95, 0.58 ], [ 0.86, 0.68 ], [ 0, 0.68 ] ],
	rivet: [ [ 0, 0 ], [ 1, 0 ], [ 0.96, 0.16 ], [ 0.75, 0.36 ], [ 0.4, 0.46 ], [ 0, 0.48 ] ],
	flat: [ [ 0, 0 ], [ 1, 0 ], [ 1, 0.05 ], [ 0.93, 0.08 ], [ 0, 0.08 ] ],
};
const BOLT_RECESS = { pan: 'phillips', socket: 'hex', rivet: 'none', flat: 'phillips', hex: 'none' };

function lathe( profile, seg ) {

	return new THREE.LatheGeometry( profile.map( ( [ r, y ] ) => new THREE.Vector2( r, y ) ), seg );

}

function boltGeometry( kind ) {

	return cached( 'bolt:' + kind, () => {

		let g;
		if ( kind === 'hex' ) {

			const washer = lathe( [ [ 0, 0 ], [ 1.15, 0 ], [ 1.15, 0.1 ], [ 0, 0.1 ] ], 20 ).toNonIndexed();
			const head = lathe( [ [ 0, 0.1 ], [ 0.92, 0.1 ], [ 0.92, 0.6 ], [ 0.78, 0.72 ], [ 0, 0.72 ] ], 6 ).toNonIndexed();
			head.rotateY( Math.PI / 6 );
			head.computeVertexNormals(); // flat facets
			washer.computeVertexNormals();
			g = mergeGeometries( [ washer, head ] );

		} else {

			g = lathe( BOLT_PROFILES[ kind ] ?? BOLT_PROFILES.pan, kind === 'flat' ? 16 : 20 ).toNonIndexed();
			g.computeVertexNormals();
			g = mergeGeometries( [ g ] );

		}

		// Planar top-down UVs: the recess map is drawn in head-radius units around the centre.
		const p = g.attributes.position, uv = new Float32Array( p.count * 2 );
		for ( let i = 0; i < p.count; i ++ ) {

			uv[ i * 2 ] = p.getX( i ) * 0.5 + 0.5; uv[ i * 2 + 1 ] = - p.getZ( i ) * 0.5 + 0.5;

		}

		g.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
		return g;

	} );

}

function recessMaps( recess ) {

	return cached( 'recess:' + recess, () => {

		const N = 128, c = makeCanvas( N ), g = c.getContext( '2d' );
		g.fillStyle = '#fff'; g.fillRect( 0, 0, N, N );
		g.fillStyle = '#000'; g.strokeStyle = '#000';
		g.translate( N / 2, N / 2 );
		const R = N * 0.25; // head radius = N/4 in these UVs
		if ( recess === 'phillips' ) {

			g.lineCap = 'round'; g.lineWidth = R * 0.24;
			g.beginPath(); g.moveTo( - R * 0.55, 0 ); g.lineTo( R * 0.55, 0 ); g.moveTo( 0, - R * 0.55 ); g.lineTo( 0, R * 0.55 ); g.stroke();
			g.beginPath(); g.arc( 0, 0, R * 0.2, 0, Math.PI * 2 ); g.fill();

		} else if ( recess === 'slot' ) {

			g.fillRect( - R * 0.85, - R * 0.12, R * 1.7, R * 0.24 );

		} else if ( recess === 'hex' ) {

			g.beginPath();
			for ( let i = 0; i < 6; i ++ ) g.lineTo( Math.cos( i * Math.PI / 3 ) * R * 0.5, Math.sin( i * Math.PI / 3 ) * R * 0.5 );
			g.closePath(); g.fill();

		} else if ( recess === 'torx' ) {

			g.beginPath();
			for ( let i = 0; i <= 72; i ++ ) {

				const a = ( i / 72 ) * Math.PI * 2, r = R * ( 0.42 + 0.12 * Math.cos( a * 6 ) );
				g.lineTo( Math.cos( a ) * r, Math.sin( a ) * r );

			}

			g.fill();

		}

		const H = blurField( canvasToHeight( c ), 1.5, { wrap: false, passes: 2 } );
		const normalMap = heightToNormalMap( H, { strength: 5, wrap: false, repeat: false } );
		const map = colorTexture( paintCanvas( N, N, ( x, y, i, out ) => {

			out[ 0 ] = out[ 1 ] = out[ 2 ] = 255 * Math.pow( 0.12 + 0.88 * H.data[ i ], 1 / 2.2 );

		} ), { repeat: false } );
		return { normalMap, map };

	} );

}

/**
 * 螺丝/螺栓/铆钉（实例化，一次 draw call）。每颗随机转角（种子化），十字/内六角/槽/梅花凹槽用小贴图画出。
 * Instanced screws, bolts and rivets (one draw call). Each gets a seeded random spin; Phillips / hex socket / slot /
 * torx recesses are a small normal + cavity map on the head.
 * @param {{p:number[], n?:number[]}[]} points 位置与朝外法线（默认 +y），可用 rectPoints / ringPoints 生成 / positions and outward normals
 * @param {{kind?:'pan'|'socket'|'hex'|'rivet'|'flat', recess?:'phillips'|'slot'|'hex'|'torx'|'none', radius?:number, height?:number,
 *   color?:THREE.ColorRepresentation, metalness?:number, roughness?:number, seed?:number, material?:THREE.Material}} [o]
 *   kind 头型（默认 pan 圆头）；radius 头半径（世界单位，默认 0.01）；height 高度倍数（默认 1）
 * 三角形 / triangles per screw: pan 240，socket 160，hex 168，rivet 200，flat 128；× 数量（100 颗圆头 = 24k）
 * @returns {THREE.InstancedMesh}
 */
export function bolts( points, o = {} ) {

	const kind = o.kind ?? 'pan', recess = o.recess ?? BOLT_RECESS[ kind ];
	const geo = boltGeometry( kind );
	let mat = o.material;
	if ( ! mat ) {

		const r = recess !== 'none' ? recessMaps( recess ) : null;
		mat = new THREE.MeshStandardMaterial( { color: o.color ?? 0xb8b8b8, metalness: o.metalness ?? 1, roughness: o.roughness ?? 0.32, map: r?.map ?? null, normalMap: r?.normalMap ?? null } );

	}

	const mesh = new THREE.InstancedMesh( geo, mat, points.length );
	const rng = makeRng( o.seed ?? 7 ), up = new THREE.Vector3( 0, 1, 0 ), q = new THREE.Quaternion(), spin = new THREE.Quaternion();
	const m = new THREE.Matrix4(), s = o.radius ?? 0.01, sc = new THREE.Vector3( s, s * ( o.height ?? 1 ), s );
	points.forEach( ( pt, i ) => {

		const n = V( pt.n ?? [ 0, 1, 0 ] ).normalize();
		q.setFromUnitVectors( up, n ).multiply( spin.setFromAxisAngle( up, pt.spin ?? rng.next() * Math.PI * 2 ) );
		mesh.setMatrixAt( i, m.compose( V( pt.p ), q, sc ) );

	} );
	mesh.instanceMatrix.needsUpdate = true;
	mesh.computeBoundingSphere();
	mesh.name = 'bolts';
	return mesh;

}

/**
 * 矩形阵列的点（面板四角、成排螺丝）/ points on a rectangle (panel corners, rows of screws).
 * @param {{center:number[], normal?:number[], up?:number[], size:number[], count?:number[], inset?:number}} o
 *   size [w,h]；count [nx,ny]（默认 [2,2] = 四角；只放边上的点）；inset 向内缩进 / size; count per side (edges only); inset
 * @returns {{p:number[], n:number[]}[]}
 */
export function rectPoints( o ) {

	const n = V( o.normal ?? [ 0, 0, 1 ] ).normalize(), up = V( o.up ?? ( Math.abs( n.y ) > 0.9 ? [ 0, 0, - 1 ] : [ 0, 1, 0 ] ) );
	const u = new THREE.Vector3().crossVectors( up, n ).normalize(), v = new THREE.Vector3().crossVectors( n, u );
	const [ w, h ] = o.size, [ nx, ny ] = o.count ?? [ 2, 2 ], ins = o.inset ?? 0, c = V( o.center );
	const out = [];
	for ( let j = 0; j < ny; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		if ( j > 0 && j < ny - 1 && i > 0 && i < nx - 1 ) continue;
		const x = ( nx > 1 ? i / ( nx - 1 ) - 0.5 : 0 ) * ( w - 2 * ins ), y = ( ny > 1 ? j / ( ny - 1 ) - 0.5 : 0 ) * ( h - 2 * ins );
		out.push( { p: c.clone().addScaledVector( u, x ).addScaledVector( v, y ).toArray(), n: n.toArray() } );

	}

	return out;

}

/**
 * 圆周阵列的点（法兰、镜头卡口、盖子）/ points on a circle (flanges, mounts, lids).
 * @param {{center:number[], normal?:number[], radius:number, count:number, phase?:number}} o
 * @returns {{p:number[], n:number[]}[]}
 */
export function ringPoints( o ) {

	const n = V( o.normal ?? [ 0, 1, 0 ] ).normalize(), up = Math.abs( n.y ) > 0.9 ? new THREE.Vector3( 0, 0, - 1 ) : new THREE.Vector3( 0, 1, 0 );
	const u = new THREE.Vector3().crossVectors( up, n ).normalize(), v = new THREE.Vector3().crossVectors( n, u ), c = V( o.center );
	return Array.from( { length: o.count }, ( _, i ) => {

		const a = ( o.phase ?? 0 ) + ( i / o.count ) * Math.PI * 2;
		return { p: c.clone().addScaledVector( u, Math.cos( a ) * o.radius ).addScaledVector( v, Math.sin( a ) * o.radius ).toArray(), n: n.toArray() };

	} );

}

// ---------------------------------------------------------------- curves: cables, straps, instances along a curve

/**
 * 沿曲线的平行移动标架（不翻转）/ rotation-minimising frames along a curve (no flips).
 * @param {THREE.Curve<THREE.Vector3>} curve
 * @param {number} n 段数 / segments
 * @param {number[]} [up=[0,1,0]] 初始“上”方向 / initial up
 * @returns {{p:THREE.Vector3, t:THREE.Vector3, n:THREE.Vector3, b:THREE.Vector3}[]} n+1 个 / n+1 frames (b = side)
 */
export function curveFrames( curve, n, up = [ 0, 1, 0 ] ) {

	const out = [];
	let nrm = V( up );
	for ( let i = 0; i <= n; i ++ ) {

		const s = i / n, p = curve.getPointAt( s ), t = curve.getTangentAt( s ).normalize();
		nrm.addScaledVector( t, - nrm.dot( t ) );
		if ( nrm.lengthSq() < 1e-8 ) nrm = new THREE.Vector3( 1, 0, 0 ).addScaledVector( t, - t.x );
		nrm.normalize();
		const b = new THREE.Vector3().crossVectors( t, nrm ).normalize();
		out.push( { p, t, n: nrm.clone(), b } );

	}

	return out;

}

/**
 * 线缆/软管：两端可按给定方向直着伸出，中间按重力下垂（抛物线近似悬链线），可加轻微扭动、波纹管棱、两端护套与插头。
 * Cable or hose: leaves each end straight along a given direction, sags under gravity in between (parabola ≈ catenary),
 * with optional seeded wobble, corrugation ribs, strain-relief boots and plugs.
 * @param {object} o
 * @param {number[]} [o.from] 起点 / start @param {number[]} [o.to] 终点 / end
 * @param {number[]} [o.fromDir] 起点伸出方向（默认朝终点）/ direction out of the start
 * @param {number[]} [o.toDir] 终点伸出方向（指向线缆外，默认朝起点）/ direction out of the end, pointing along the cable
 * @param {number[][]} [o.points] 直接给经过点（代替 from/to/sag）/ explicit through-points instead
 * @param {number} [o.sag=0.2] 中点下垂量（世界单位）/ mid-span sag (world units)
 * @param {number} [o.lead] 两端直段长度（默认跨度 15%）/ straight length at each end (15% of span)
 * @param {number} [o.radius=0.015] @param {number} [o.radial=12] 圆周段数 @param {number} [o.segments=96] 长度段数
 * @param {number} [o.wobble=0] 扭动幅度（世界单位）/ seeded wobble amplitude @param {number} [o.seed=1]
 * @param {number} [o.floor] 地面高度：中间点不低于 floor + radius（线缆躺在桌面上而不是穿进地面）/ keep the cable above this height (lying on a table)
 * @param {{count:number, depth?:number}} [o.ribs] 波纹管：棱数、深度（半径比例，默认 0.12）/ corrugation
 * @param {{length?:number, radius?:number, plug?:number}|boolean} [o.boots] 两端护套（默认长 6×半径）与插头 / boots and plugs
 * @param {THREE.ColorRepresentation} [o.color=0x1a1a1a] @param {THREE.Material} [o.material] 线缆材质（默认黑色橡胶）
 * 三角形 / triangles: 2·segments·radial（默认 2,304）+ 护套与插头每端约 24·radial（默认两端共 576）
 * @returns {THREE.Group} userData.curve 曲线 / the curve; children: tube, boots
 */
export function cable( o ) {

	let pts;
	if ( o.points ) pts = o.points.map( V );
	else {

		const a = V( o.from ), b = V( o.to ), span = a.distanceTo( b );
		const lead = o.lead ?? span * 0.15;
		const da = o.fromDir ? V( o.fromDir ).normalize() : b.clone().sub( a ).normalize();
		const db = o.toDir ? V( o.toDir ).normalize() : a.clone().sub( b ).normalize();
		const a1 = a.clone().addScaledVector( da, lead ), b1 = b.clone().addScaledVector( db, lead );
		const noise = makeNoise3( ( o.seed ?? 1 ) * 19 + 3 ), M = 8, sag = o.sag ?? 0.2, wob = o.wobble ?? 0;
		pts = [ a, a1 ];
		for ( let k = 1; k < M; k ++ ) {

			const s = k / M, p = a1.clone().lerp( b1, s );
			p.y -= sag * 4 * s * ( 1 - s );
			if ( wob ) p.add( new THREE.Vector3( noise( s * 3, 0.5, 1 ), noise( s * 3, 4.5, 2 ), noise( s * 3, 8.5, 3 ) ).multiplyScalar( wob * 4 * s * ( 1 - s ) * 2 ) );
			pts.push( p );

		}

		pts.push( b1, b );
		if ( o.floor !== undefined ) for ( const p of pts ) p.y = Math.max( p.y, o.floor + ( o.radius ?? 0.015 ) );

	}

	const curve = new THREE.CatmullRomCurve3( pts, false, 'centripetal' );
	const radius = o.radius ?? 0.015, radial = o.radial ?? 12;
	const ribs = o.ribs, segs = Math.max( o.segments ?? 96, ribs ? ribs.count * 6 : 0 );
	const geo = new THREE.TubeGeometry( curve, segs, radius, radial, false );
	if ( ribs ) {

		const pos = geo.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3(), dep = ribs.depth ?? 0.12;
		for ( let i = 0; i <= segs; i ++ ) {

			curve.getPointAt( i / segs, c );
			const k = 1 + dep * ( Math.pow( 0.5 + 0.5 * Math.cos( ( i / segs ) * ribs.count * Math.PI * 2 ), 0.7 ) - 0.5 );
			for ( let j = 0; j <= radial; j ++ ) {

				const idx = i * ( radial + 1 ) + j;
				v.fromBufferAttribute( pos, idx ).sub( c ).multiplyScalar( k ).add( c );
				pos.setXYZ( idx, v.x, v.y, v.z );

			}

		}

		geo.computeVertexNormals();

	}

	const mat = o.material ?? new THREE.MeshStandardMaterial( { color: o.color ?? 0x1a1a1a, roughness: 0.55, metalness: 0 } );
	const group = new THREE.Group();
	group.name = 'cable';
	const tube = new THREE.Mesh( geo, mat );
	tube.name = 'cable-tube';
	group.add( tube );
	if ( o.boots ) {

		const bo = o.boots === true ? {} : o.boots, len = bo.length ?? radius * 6, br = bo.radius ?? radius * 1.7, plug = bo.plug ?? radius * 5;
		const boot = new THREE.CylinderGeometry( radius * 1.15, br, len, radial, 4 ).translate( 0, len / 2, 0 );
		// Grip rings on the boot.
		const bp = boot.attributes.position;
		for ( let i = 0; i < bp.count; i ++ ) {

			const y = bp.getY( i ) / len, k = 1 + 0.08 * Math.sin( y * Math.PI * 6 );
			bp.setX( i, bp.getX( i ) * k ); bp.setZ( i, bp.getZ( i ) * k );

		}

		boot.computeVertexNormals();
		const plugGeo = roundedCylinder( br * 1.12, plug, { radial, bevel: br * 0.25, bevelSegments: 2 } ).translate( 0, - plug / 2, 0 );
		const plugMat = new THREE.MeshStandardMaterial( { color: 0x2a2a2a, roughness: 0.4, metalness: 0.1 } );
		const up = new THREE.Vector3( 0, 1, 0 );
		for ( const [ at, dir ] of [ [ 0, 1 ], [ 1, - 1 ] ] ) {

			const p = curve.getPointAt( at ), t = curve.getTangentAt( at ).multiplyScalar( dir );
			const q = new THREE.Quaternion().setFromUnitVectors( up, t );
			const b = new THREE.Mesh( boot, mat ); b.position.copy( p ); b.quaternion.copy( q );
			const pl = new THREE.Mesh( plugGeo, plugMat ); pl.position.copy( p ); pl.quaternion.copy( q );
			b.name = 'cable-boot'; pl.name = 'cable-plug';
			group.add( b, pl );

		}

	}

	group.userData.curve = curve;
	group.userData.triangles = tris( geo );
	return group;

}

/**
 * 扁带（矩形截面沿曲线扫掠）：背带、皮带、扎带、排线。
 * Strap: a rectangular section swept along a curve (straps, belts, ties, ribbon cables).
 * @param {THREE.Curve<THREE.Vector3>|number[][]} path 曲线或经过点 / a curve or through-points
 * @param {{width?:number, thickness?:number, segments?:number, up?:number[], uvTile?:number, material?:THREE.Material, color?:THREE.ColorRepresentation}} [o]
 *   width 宽（默认 0.04）；thickness 厚（默认 0.004）；up 宽度方向的参考“上”（默认 [0,1,0]，宽度垂直于它）；uvTile u 方向每多少世界单位平铺一次（默认 = width）
 * 三角形 / triangles: 8·segments（默认 64 → 512），两端不封口 / open ends.
 * @returns {THREE.Mesh}
 */
export function strap( path, o = {} ) {

	const curve = Array.isArray( path ) ? new THREE.CatmullRomCurve3( path.map( V ), false, 'centripetal' ) : path;
	const n = o.segments ?? 64, w = ( o.width ?? 0.04 ) / 2, t = ( o.thickness ?? 0.004 ) / 2;
	const F = curveFrames( curve, n, o.up ?? [ 0, 1, 0 ] ), len = curve.getLength(), tile = o.uvTile ?? w * 2;
	const pos = [], nor = [], uv = [], idx = [];
	// Four faces, each with its own vertices (hard edges): top (+n), bottom (−n), side (+b), side (−b).
	const faces = [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ];
	for ( const [ fn, fb ] of faces ) {

		const base = pos.length / 3;
		for ( let i = 0; i <= n; i ++ ) {

			const { p, n: N, b: B } = F[ i ];
			const nn = N.clone().multiplyScalar( fn ).addScaledVector( B, fb );
			for ( const s of [ - 1, 1 ] ) {

				// Across the face: for top/bottom vary along b; for sides vary along n.
				const off = fn ? B.clone().multiplyScalar( s * w ).addScaledVector( N, fn * t ) : N.clone().multiplyScalar( s * t ).addScaledVector( B, fb * w );
				pos.push( p.x + off.x, p.y + off.y, p.z + off.z );
				nor.push( nn.x, nn.y, nn.z );
				uv.push( ( i / n ) * len / tile, s * 0.5 + 0.5 );

			}

		}

		for ( let i = 0; i < n; i ++ ) {

			const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
			const flip = ( fn === 1 || fb === - 1 );
			if ( flip ) idx.push( a, c, b, b, c, d ); else idx.push( a, b, c, b, d, c );

		}

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( nor, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( uv, 2 ) );
	g.setIndex( idx );
	const mesh = new THREE.Mesh( g, o.material ?? new THREE.MeshStandardMaterial( { color: o.color ?? 0x222222, roughness: 0.8 } ) );
	mesh.name = 'strap';
	mesh.userData.curve = curve;
	return mesh;

}

/**
 * 沿曲线等距排布实例（拉链齿、缝线针脚、链环、扎带、铆钉排）：一次 draw call。
 * Instances evenly along a curve (zipper teeth, stitches, chain links, cable ties, rivet rows): one draw call.
 * 实例的局部 +x 沿切线，+y 沿标架法线（up），+z 沿侧向。/ Instance local +x follows the tangent, +y the frame normal, +z the side.
 * @param {THREE.Curve<THREE.Vector3>|number[][]} path
 * @param {THREE.BufferGeometry} geometry @param {THREE.Material} material
 * @param {{count?:number, spacing?:number, up?:number[], offset?:number[], alternate?:number, scale?:number|number[], from?:number, to?:number}} [o]
 *   count 或 spacing（世界单位）二选一；offset [沿法线, 沿侧向]；alternate 隔一个往侧向偏移这么多（拉链两排齿交错）；from/to 曲线区间 0..1
 * 三角形 / triangles: 实例几何三角形 × 数量 / instance triangles × count.
 * @returns {THREE.InstancedMesh}
 */
export function alongCurve( path, geometry, material, o = {} ) {

	const curve = Array.isArray( path ) ? new THREE.CatmullRomCurve3( path.map( V ), false, 'centripetal' ) : path;
	const a = o.from ?? 0, b = o.to ?? 1, len = curve.getLength() * ( b - a );
	const count = o.count ?? Math.max( 1, Math.floor( len / ( o.spacing ?? 0.01 ) ) );
	const mesh = new THREE.InstancedMesh( geometry, material, count );
	const F = curveFrames( curve, 512, o.up ?? [ 0, 1, 0 ] ), m = new THREE.Matrix4(), basis = new THREE.Matrix4();
	const sc = Array.isArray( o.scale ) ? new THREE.Vector3( ...o.scale ) : new THREE.Vector3( 1, 1, 1 ).multiplyScalar( o.scale ?? 1 );
	const [ on, ob ] = o.offset ?? [ 0, 0 ];
	for ( let i = 0; i < count; i ++ ) {

		const s = a + ( b - a ) * ( count > 1 ? i / ( count - 1 ) : 0.5 ), k = Math.min( 511, Math.floor( s * 512 ) ), fr = F[ k ];
		const p = curve.getPointAt( s ).addScaledVector( fr.n, on ).addScaledVector( fr.b, ob + ( o.alternate ? ( i % 2 ? 1 : - 1 ) * o.alternate : 0 ) );
		basis.makeBasis( fr.t, fr.n, fr.b ).setPosition( p );
		m.makeScale( sc.x, sc.y, sc.z ).premultiply( basis );
		mesh.setMatrixAt( i, m );

	}

	mesh.instanceMatrix.needsUpdate = true;
	mesh.computeBoundingSphere();
	return mesh;

}

// ---------------------------------------------------------------- perforation, grilles, vents

/**
 * 穿孔/网罩贴图（可平铺）：alpha（孔 = 0）、孔边倒角法线、孔内压暗的乘色贴图。
 * Tileable perforation maps: alpha (holes = 0), chamfered-edge normals and a multiplier map with dark holes.
 * @param {{pattern?:'round'|'hex'|'square'|'slot', cells?:number, hole?:number, size?:number, bevel?:number}} [o]
 *   pattern 孔型（默认 hex 蜂窝排列圆孔）；cells 每张贴图横向孔数（默认 8）；hole 孔径/孔距（默认 0.6）；size 贴图边长（默认 256）
 * @returns {{alphaMap:THREE.Texture, normalMap:THREE.Texture, map:THREE.Texture, cells:number}}
 */
export function perforationMaps( o = {} ) {

	const pattern = o.pattern ?? 'hex', cells = o.cells ?? 8, hole = o.hole ?? 0.6, size = texSize( o.size ?? 256 ), bevel = o.bevel ?? 0.08;
	return cached( 'perf:' + JSON.stringify( { pattern, cells, hole, size, bevel } ), () => {

		// Rows: hex patterns need an even row count so the texture tiles.
		const rows = pattern === 'hex' ? Math.max( 2, 2 * Math.round( cells / Math.sqrt( 3 ) ) ) : pattern === 'slot' ? Math.max( 1, Math.round( cells / 2.5 ) ) : cells;
		const dist = new Float32Array( size * size );
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			const u = ( x + 0.5 ) / size * cells, v = ( y + 0.5 ) / size * rows;
			const row = Math.floor( v ), shift = pattern === 'hex' && row % 2 ? 0.5 : 0;
			const cx = ( ( u + shift ) % 1 + 1 ) % 1 - 0.5, cy = v - row - 0.5;
			let d; // signed distance to the hole edge, in pitch units (negative inside)
			const r = hole / 2;
			if ( pattern === 'square' ) d = Math.max( Math.abs( cx ), Math.abs( cy ) ) - r;
			else if ( pattern === 'slot' ) {

				const sy = cy * cells / rows; // undo the row stretch so slots stay round-ended
				const hx = 0.5 - ( 1 - hole ) / 2 - r * 0.35;
				d = Math.hypot( Math.max( Math.abs( cx ) - Math.max( 0, hx - r * 0.35 ), 0 ), sy ) - r * 0.35;

			} else {

				const sy = cy * ( pattern === 'hex' ? ( cells / rows ) : 1 );
				d = Math.hypot( cx, sy ) - r;

			}

			dist[ y * size + x ] = d;

		}

		const px = 1 / ( size / cells ); // one pixel in pitch units
		const alphaMap = dataTexture( paintCanvas( size, size, ( x, y, i, out ) => {

			out[ 0 ] = out[ 1 ] = out[ 2 ] = 255 * Math.min( 1, Math.max( 0, dist[ i ] / px + 0.5 ) );

		} ) );
		const H = { data: dist.map( ( d ) => Math.min( 1, Math.max( 0, d / bevel ) ) ), width: size, height: size };
		const normalMap = heightToNormalMap( H, { strength: size / cells * bevel * 1.5 } );
		const map = colorTexture( paintCanvas( size, size, ( x, y, i, out ) => {

			const d = dist[ i ], v = d < 0 ? 0.04 : 0.75 + 0.25 * Math.min( 1, d / bevel );
			out[ 0 ] = out[ 1 ] = out[ 2 ] = 255 * Math.pow( v, 1 / 2.2 );

		} ) );
		return { alphaMap, normalMap, map, cells };

	} );

}

/**
 * 穿孔网罩面板（朝 +z，居中）：喇叭网、散热孔、过滤网。默认“假孔”（孔内画暗、mipmap 下不闪），cutout:true 为真镂空（alphaTest）
 * 并在后面放暗色衬板。孔距小于约 4 像素时用假孔，否则会出摩尔纹。
 * Perforated grille panel facing +z, centred: speaker grilles, vent holes, filters. Default paints holes dark (stable
 * under mipmapping); cutout:true makes real holes (alphaTest) with a dark backing plate. Use painted holes when the
 * pitch is under ~4 px on screen, or it moirés.
 * @param {number} w @param {number} h 尺寸 / size
 * @param {{pattern?:string, pitch?:number, hole?:number, cutout?:boolean, color?:THREE.ColorRepresentation, metalness?:number, roughness?:number,
 *   frame?:number, frameColor?:THREE.ColorRepresentation, radius?:number, depth?:number}} [o]
 *   pitch 孔距（世界单位，默认 0.012）；frame 边框宽（默认 0 无边框）；radius 圆角；depth 衬板深度（默认 pitch）
 * 三角形 / triangles: 2（面板）+ 2（衬板）+ 边框约 300–600
 * @returns {THREE.Group}
 */
export function grille( w, h, o = {} ) {

	const pitch = o.pitch ?? 0.012, maps = perforationMaps( { pattern: o.pattern, hole: o.hole, cells: o.cells ?? 8 } );
	const rep = [ w / ( pitch * maps.cells ), h / ( pitch * maps.cells ) ];
	const set = ( t ) => {

		const c = t.clone(); c.repeat.set( rep[ 0 ], rep[ 1 ] ); return c;

	};

	const group = new THREE.Group();
	group.name = 'grille';
	const r = o.radius ?? 0;
	const shape = roundedRectShape( w, h, r );
	const plateGeo = new THREE.ShapeGeometry( shape, 6 );
	// ShapeGeometry UVs are the shape coordinates: normalise to 0..1 so the repeat is per panel.
	const uvA = plateGeo.attributes.uv;
	for ( let i = 0; i < uvA.count; i ++ ) uvA.setXY( i, uvA.getX( i ) / w + 0.5, uvA.getY( i ) / h + 0.5 );
	const mat = new THREE.MeshStandardMaterial( { color: o.color ?? 0x2b2b2b, metalness: o.metalness ?? 0.6, roughness: o.roughness ?? 0.45, map: set( maps.map ), normalMap: set( maps.normalMap ) } );
	if ( o.cutout ) {

		mat.alphaMap = set( maps.alphaMap ); mat.alphaTest = 0.5; mat.map = null; mat.side = THREE.DoubleSide;
		const back = new THREE.Mesh( new THREE.ShapeGeometry( shape, 6 ), new THREE.MeshStandardMaterial( { color: 0x050505, roughness: 0.9 } ) );
		back.position.z = - ( o.depth ?? pitch );
		group.add( back );

	}

	group.add( new THREE.Mesh( plateGeo, mat ) );
	if ( o.frame ) {

		const outer = roundedRectShape( w + 2 * o.frame, h + 2 * o.frame, r + o.frame );
		outer.holes.push( roundedRectShape( w, h, r ) );
		const fg = new THREE.ExtrudeGeometry( outer, { depth: o.frame * 0.6, bevelEnabled: true, bevelThickness: o.frame * 0.3, bevelSize: o.frame * 0.3, bevelSegments: 3, curveSegments: 6 } );
		fg.translate( 0, 0, - o.frame * 0.3 );
		group.add( new THREE.Mesh( fg, new THREE.MeshStandardMaterial( { color: o.frameColor ?? 0x777777, metalness: 0.8, roughness: 0.35 } ) ) );

	}

	return group;

}

/** 圆角矩形 Shape（居中）/ centred rounded-rectangle Shape. */
export function roundedRectShape( w, h, r = 0 ) {

	r = Math.min( r, w / 2, h / 2 );
	const s = new THREE.Shape(), x = - w / 2, y = - h / 2;
	s.moveTo( x + r, y );
	s.lineTo( x + w - r, y ); if ( r ) s.quadraticCurveTo( x + w, y, x + w, y + r );
	s.lineTo( x + w, y + h - r ); if ( r ) s.quadraticCurveTo( x + w, y + h, x + w - r, y + h );
	s.lineTo( x + r, y + h ); if ( r ) s.quadraticCurveTo( x, y + h, x, y + h - r );
	s.lineTo( x, y + r ); if ( r ) s.quadraticCurveTo( x, y, x + r, y );
	return s;

}

/**
 * 百叶通风口（朝 +z，居中）：暗色凹槽 + 一排倾斜的圆角叶片（实例化）。比贴图更立体，近景用。
 * Louvred vent facing +z, centred: a dark recess with a row of tilted rounded slats (instanced). Reads in close-ups.
 * @param {number} w @param {number} h
 * @param {{count?:number, depth?:number, angle?:number, color?:THREE.ColorRepresentation, material?:THREE.Material}} [o]
 *   count 叶片数（默认按 h/0.012）；depth 凹槽深（默认 h·0.15）；angle 叶片倾角（弧度，默认 0.5）
 * 三角形 / triangles: 12（凹槽）+ 每片 200（segments 2 圆角盒）× count
 * @returns {THREE.Group}
 */
export function louvers( w, h, o = {} ) {

	const count = o.count ?? Math.max( 3, Math.round( h / 0.012 ) ), depth = o.depth ?? h * 0.15, pitch = h / count;
	const group = new THREE.Group();
	group.name = 'louvers';
	const box = new THREE.Mesh( new THREE.BoxGeometry( w, h, depth ).translate( 0, 0, - depth / 2 ), new THREE.MeshStandardMaterial( { color: 0x060606, roughness: 0.9, side: THREE.BackSide } ) );
	group.add( box );
	const slat = roundedBox( w * 0.98, pitch * 0.8, Math.max( pitch * 0.12, 0.0008 ), { segments: 2, radius: Math.max( pitch * 0.05, 0.0003 ) } );
	const mat = o.material ?? new THREE.MeshStandardMaterial( { color: o.color ?? 0x3a3a3a, roughness: 0.5, metalness: 0.2 } );
	const im = new THREE.InstancedMesh( slat, mat, count );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 1, 0, 0 ), o.angle ?? 0.5 );
	for ( let i = 0; i < count; i ++ ) im.setMatrixAt( i, m.compose( new THREE.Vector3( 0, - h / 2 + pitch * ( i + 0.5 ), - depth * 0.45 ), q, new THREE.Vector3( 1, 1, 1 ) ) );
	im.instanceMatrix.needsUpdate = true;
	im.computeBoundingSphere();
	group.add( im );
	return group;

}
