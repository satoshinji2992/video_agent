// Object-space surface patches for MeshStandardMaterial / MeshPhysicalMaterial (onBeforeCompile).
// A patch's fragment snippet gets the object-space position and normal (InstancedMesh aware) and can change albedo,
// roughness, metalness, emissive and the object-space normal. Several patches stack on one material (detail
// normals + panel seams, say); the normal change is added on top of any normalMap the material already has.
// No UVs are needed, so it works on displaced, lathed and merged geometry alike.
// 物体空间表面补丁：片元着色器拿到物体空间坐标与法线（兼容 InstancedMesh），可改颜色/粗糙度/金属度/自发光/法线。
// 一个材质可叠加多个补丁（如三平面细节 + 面板缝），法线改动叠加在材质原有的 normalMap 之上。不需要 UV。
import * as THREE from 'three';

/** 三平面法线贴图 GLSL（whiteout 混合）/ triplanar normal mapping GLSL (whiteout blend). */
export const TRIPLANAR_GLSL = /* glsl */`
vec3 kitTriplanarNormal( sampler2D map, vec3 p, vec3 n, float scale, float strength ) {
	vec3 w = abs( n ); w *= w; w *= w; w /= ( w.x + w.y + w.z );
	vec3 tx = texture2D( map, p.zy * scale ).xyz * 2.0 - 1.0;
	vec3 ty = texture2D( map, p.xz * scale + 0.37 ).xyz * 2.0 - 1.0;
	vec3 tz = texture2D( map, p.xy * scale + 0.71 ).xyz * 2.0 - 1.0;
	tx.xy *= strength; ty.xy *= strength; tz.xy *= strength;
	tx = vec3( tx.xy + n.zy, abs( tx.z ) * n.x );
	ty = vec3( ty.xy + n.xz, abs( ty.z ) * n.y );
	tz = vec3( tz.xy + n.xy, abs( tz.z ) * n.z );
	return normalize( tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z );
}
vec4 kitTriplanar( sampler2D map, vec3 p, vec3 n, float scale ) {
	vec3 w = abs( n ); w *= w; w *= w; w /= ( w.x + w.y + w.z );
	return texture2D( map, p.zy * scale ) * w.x + texture2D( map, p.xz * scale + 0.37 ) * w.y + texture2D( map, p.xy * scale + 0.71 ) * w.z;
}
float kitTriplanarValue( sampler2D map, vec3 p, vec3 n, float scale, int ch ) {
	vec4 m = kitTriplanar( map, p, n, scale );
	return ch == 0 ? m.r : ch == 1 ? m.g : ch == 2 ? m.b : m.a;
}
`;

const VARYINGS = 'varying vec3 vKitPos;\nvarying vec3 vKitN;\nvarying vec3 vKitM0;\nvarying vec3 vKitM1;\nvarying vec3 vKitM2;';

let keySeq = 0;
const keys = new Map();
/**
 * 补丁内 uniform 命名：同一材质上第 i 个补丁用后缀 i，不同材质的同类补丁生成相同源码、共用一个着色器程序。
 * Uniform names for the next patch on this material: suffix = patch index, so equal patches on different materials
 * produce the same source and share one compiled program (each material keeps its own uniform values).
 */
export const patchName = ( material, base ) => `${base}${material.userData.kitPatches?.length ?? 0}`;

function compile( material ) {

	const patches = material.userData.kitPatches;
	const pars = patches.map( ( p ) => p.pars ).join( '\n' );
	const surface = patches.map( ( p ) => `\t{\n${p.surface}\n\t}` ).join( '\n' );
	const output = patches.filter( ( p ) => p.output ).map( ( p ) => `\t{\n${p.output}\n\t}` ).join( '\n' );
	const uniforms = Object.assign( {}, ...patches.map( ( p ) => p.uniforms ) );
	const src = pars + '\n//--\n' + surface + '\n//--\n' + output;
	if ( ! keys.has( src ) ) keys.set( src, 'kit' + ( ++ keySeq ) );
	const key = keys.get( src );
	material.userData.kitUniforms = uniforms;
	material.onBeforeCompile = ( shader ) => {

		Object.assign( shader.uniforms, uniforms );
		shader.vertexShader = shader.vertexShader
			.replace( '#include <common>', '#include <common>\n' + VARYINGS )
			.replace( '#include <begin_vertex>', /* glsl */`#include <begin_vertex>
	vKitPos = transformed;
	vKitN = objectNormal;
	{
		mat3 kitA = mat3( 1.0 );
		#ifdef USE_INSTANCING
			mat3 kitIm = mat3( instanceMatrix );
			kitA = mat3( kitIm[ 0 ] / dot( kitIm[ 0 ], kitIm[ 0 ] ), kitIm[ 1 ] / dot( kitIm[ 1 ], kitIm[ 1 ] ), kitIm[ 2 ] / dot( kitIm[ 2 ], kitIm[ 2 ] ) );
		#endif
		mat3 kitM = normalMatrix * kitA;
		vKitM0 = kitM[ 0 ]; vKitM1 = kitM[ 1 ]; vKitM2 = kitM[ 2 ];
	}` );
		shader.fragmentShader = shader.fragmentShader
			.replace( '#include <common>', '#include <common>\n' + VARYINGS + '\n' + TRIPLANAR_GLSL + '\n' + pars )
			.replace( '#include <color_fragment>', /* glsl */`#include <color_fragment>
	vec3 kitP = vKitPos;
	vec3 kitN = normalize( vKitN );
	vec3 kitNp = kitN;
	float kitRoughMul = 1.0, kitMetalMul = 1.0, kitRough = -1.0, kitMetal = -1.0;
	vec3 kitEmissive = vec3( 0.0 );
${surface}` )
			.replace( '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = kitRough >= 0.0 ? kitRough : roughnessFactor * kitRoughMul;' )
			.replace( '#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = kitMetal >= 0.0 ? kitMetal : metalnessFactor * kitMetalMul;' )
			.replace( '#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
	{
		mat3 kitM = mat3( vKitM0, vKitM1, vKitM2 );
		vec3 kitDelta = normalize( kitM * kitNp ) - normalize( kitM * kitN );
		#ifdef FLIP_SIDED
			kitDelta = - kitDelta;
		#endif
		#ifdef DOUBLE_SIDED
			kitDelta *= faceDirection;
		#endif
		normal = normalize( normal + kitDelta );
		nonPerturbedNormal = normalize( nonPerturbedNormal + kitDelta );
	}` )
			.replace( '#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += kitEmissive;' )
			.replace( '#include <opaque_fragment>', '#include <opaque_fragment>\n' + output );

	};

	material.customProgramCacheKey = () => key;
	material.needsUpdate = true;

}

/**
 * 给材质叠加一个物体空间补丁 / add an object-space patch to a standard/physical material (patches stack).
 *
 * 片元片段可用的变量 / variables available to the `surface` snippet:
 *   kitP (vec3) 物体空间坐标 / object-space position; kitN (vec3) 插值的几何法线 / geometric normal (object space);
 *   kitNp (vec3, 可写) 扰动后的法线，前一个补丁的结果 / writable perturbed normal (output of earlier patches);
 *   diffuseColor (vec4, 可写); kitRoughMul / kitMetalMul (float, 乘到粗糙度/金属度);
 *   kitRough / kitMetal (float, ≥0 时直接覆盖); kitEmissive (vec3, 叠加自发光) / added emissive.
 * 法线改动以“增量”叠加到材质自己的 normalMap 结果上（clearcoat 层也跟着变）。
 * The normal change is added as a delta on top of the material's own normalMap (and the clearcoat normal).
 * @param {THREE.MeshStandardMaterial} material
 * @param {{uniforms?:Object, pars?:string, surface?:string, output?:string}} o
 *   uniforms：{ name: { value } }（同一材质内名字要唯一，可用 patchName()）；pars：函数与 uniform 声明；surface：主体代码；
 *   output：在 gl_FragColor 写出之后执行（可改 gl_FragColor，能用 normal、vViewPosition、outgoingLight）
 *   / output: runs right after gl_FragColor is written (may change it; normal, vViewPosition, outgoingLight in scope)
 * @returns {THREE.MeshStandardMaterial} 同一个材质 / the same material
 */
export function patchObjectSpace( material, o ) {

	material.userData.kitPatches = [ ...( material.userData.kitPatches ?? [] ), { pars: o.pars ?? '', surface: o.surface ?? '', output: o.output ?? '', uniforms: o.uniforms ?? {} } ];
	if ( o.defines ) material.defines = { ...( material.defines ?? {} ), ...o.defines };
	compile( material );
	return material;

}

/**
 * 三平面细节：把一张可平铺的细节贴图按物体空间三平面投影贴上去，不需要 UV；再叠一层 3.7 倍的细尺度（只按主轴投影，1 次采样）
 * 消除重复感，并按细节法线偏离程度压暗凹处。推荐用打包贴图（surfaceMaps(...).packed：法线 + 粗糙度 + 明暗在一张 RGBA 里，
 * 三平面一共 3 次采样）；也可传分开的 normalMap / roughnessMap / map（每张 3 次采样，慢）。
 * Triplanar detail: projects a tileable detail texture in object space (no UVs), adds a 3.7× finer layer (dominant-axis
 * projection, one fetch) to hide tiling, and darkens cavities where the fine normal bends away. Prefer a packed texture
 * (surfaceMaps(...).packed: normal + roughness + brightness in one RGBA, 3 fetches in all); separate normalMap /
 * roughnessMap / map also work (3 fetches each: slower).
 * @param {THREE.MeshStandardMaterial} material
 * @param {{packed?:THREE.Texture, normalMap?:THREE.Texture, roughnessMap?:THREE.Texture, map?:THREE.Texture, scale?:number, strength?:number,
 *   fine?:number, cavity?:number, roughness?:[number,number], tint?:number}} o
 *   scale：每个物体单位重复几次（默认 2）；strength：法线强度（默认 1）；fine：细尺度强度（默认 0.6，0 关闭）；
 *   cavity：凹处压暗 0..1（默认 0.25）；roughness：粗糙度通道映射到 [lo, hi]（默认 [0, 1] = 原值）；tint：明暗通道强度 0..1（默认 1）
 *   / scale: repeats per object unit (default 2); strength (1); fine: finer-layer strength (0.6; 0 = off);
 *   cavity darkening 0..1 (0.25); roughness: maps the roughness channel to [lo, hi]; tint: brightness channel amount
 * 开销 / cost: 无三角形；打包贴图每像素 4 次采样 / no triangles; 4 fetches per pixel with a packed texture.
 * @returns {THREE.MeshStandardMaterial}
 */
export function triplanarDetail( material, o ) {

	const N = patchName( material, 'kitDetN' ), S = patchName( material, 'kitDetS' ), R = patchName( material, 'kitDetR' ), C = patchName( material, 'kitDetC' ), Q = patchName( material, 'kitDetQ' );
	const rr = o.roughness ?? [ 0, 1 ], fine = o.fine ?? 0.6;
	const uniforms = {
		[ S ]: { value: new THREE.Vector4( o.scale ?? 2, o.strength ?? 1, fine, o.cavity ?? 0.25 ) },
		[ Q ]: { value: new THREE.Vector3( rr[ 0 ], rr[ 1 ], o.tint ?? 1 ) },
	};
	let pars = `uniform vec4 ${S}; uniform vec3 ${Q};`;
	let body;
	if ( o.packed ) {

		uniforms[ N ] = { value: o.packed };
		pars += `uniform sampler2D ${N};`;
		body = /* glsl */`
		vec3 n0 = kitNp;
		vec3 w = abs( n0 ); w *= w; w *= w; w /= ( w.x + w.y + w.z );
		float sc = ${S}.x;
		vec4 tx = texture2D( ${N}, kitP.zy * sc ), ty = texture2D( ${N}, kitP.xz * sc + 0.37 ), tz = texture2D( ${N}, kitP.xy * sc + 0.71 );
		vec2 ax = ( tx.xy * 2.0 - 1.0 ) * ${S}.y, ay = ( ty.xy * 2.0 - 1.0 ) * ${S}.y, az = ( tz.xy * 2.0 - 1.0 ) * ${S}.y;
		vec3 nx = vec3( ax + n0.zy, abs( n0.x ) ), ny = vec3( ay + n0.xz, abs( n0.y ) ), nz = vec3( az + n0.xy, abs( n0.z ) );
		vec3 nA = normalize( nx.zyx * vec3( sign( n0.x ), 1.0, 1.0 ) * w.x + ny.xzy * vec3( 1.0, sign( n0.y ), 1.0 ) * w.y + nz.xyz * vec3( 1.0, 1.0, sign( n0.z ) ) * w.z );
		vec4 m = tx * w.x + ty * w.y + tz * w.z;
		vec3 nB = nA;
		if ( ${S}.z > 0.0 ) {
			// Finer layer: dominant-axis projection only (one fetch).
			vec3 an = abs( n0 ); vec2 fuv; vec3 fs;
			if ( an.x >= an.y && an.x >= an.z ) { fuv = kitP.zy; } else if ( an.y >= an.z ) { fuv = kitP.xz; } else { fuv = kitP.xy; }
			vec4 tf = texture2D( ${N}, fuv * sc * 3.7 + 0.53 );
			vec2 af = ( tf.xy * 2.0 - 1.0 ) * ${S}.y * ${S}.z;
			vec3 tA, bA;
			if ( an.x >= an.y && an.x >= an.z ) { tA = vec3( 0.0, 0.0, 1.0 ); bA = vec3( 0.0, 1.0, 0.0 ); }
			else if ( an.y >= an.z ) { tA = vec3( 1.0, 0.0, 0.0 ); bA = vec3( 0.0, 0.0, 1.0 ); }
			else { tA = vec3( 1.0, 0.0, 0.0 ); bA = vec3( 0.0, 1.0, 0.0 ); }
			nB = normalize( nA + af.x * tA + af.y * bA );
			m = mix( m, tf, 0.25 );
		}
		diffuseColor.rgb *= ( 1.0 - ${S}.w + ${S}.w * smoothstep( 0.55, 1.0, dot( nB, n0 ) ) ) * mix( 1.0, m.a, ${Q}.z );
		kitRoughMul *= mix( ${Q}.x, ${Q}.y, m.b );
		kitNp = nB;`;

	} else {

		uniforms[ N ] = { value: o.normalMap };
		pars += `uniform sampler2D ${N};`;
		body = /* glsl */`
		vec3 nA = kitTriplanarNormal( ${N}, kitP, kitNp, ${S}.x, ${S}.y );
		vec3 nB = ${S}.z > 0.0 ? kitTriplanarNormal( ${N}, kitP, nA, ${S}.x * 3.7, ${S}.y * ${S}.z ) : nA;
		diffuseColor.rgb *= 1.0 - ${S}.w + ${S}.w * smoothstep( 0.55, 1.0, dot( nB, kitNp ) );
		kitNp = nB;`;
		if ( o.roughnessMap ) {

			uniforms[ R ] = { value: o.roughnessMap };
			pars += `uniform sampler2D ${R};`;
			body += `\n\t\tkitRoughMul *= mix( ${Q}.x, ${Q}.y, kitTriplanar( ${R}, kitP, kitN, ${S}.x ).g );`;

		}

		if ( o.map ) {

			uniforms[ C ] = { value: o.map };
			pars += `uniform sampler2D ${C};`;
			// The map is sRGB-encoded data: decode to linear before multiplying.
			body += `\n\t\tdiffuseColor.rgb *= mix( vec3( 1.0 ), pow( kitTriplanar( ${C}, kitP, kitN, ${S}.x ).rgb, vec3( 2.2 ) ), ${Q}.z );`;

		}

	}

	return patchObjectSpace( material, { uniforms, pars, surface: body } );

}

/** 把 [x,y,z] / Vector3 转为 Vector3 / to Vector3. */
export const v3 = ( a ) => ( a?.isVector3 ? a.clone() : new THREE.Vector3( a[ 0 ], a[ 1 ], a[ 2 ] ) );
