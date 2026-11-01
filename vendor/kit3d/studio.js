// Scene helpers: a studio environment (PMREM-filtered RoomEnvironment plus softbox panels, key / rim lights and an
// optional shadow-casting key), a dark environment (black surround, one hard light) for night or void scenes, a baked
// contact shadow, a cheap ambient-occlusion blob, a ground with a subtle planar reflection that fades into the
// background, triangle counting, and the window.__three convention.
// 场景工具：影棚环境（RoomEnvironment + 柔光箱，PMREM 预滤波，主光/轮廓光，可选投影）、暗环境（黑色四周 + 一盏硬光）、
// 烘焙接触阴影、廉价 AO 阴影斑、带轻微倒影并渐隐到背景的地面、三角形统计、window.__three 约定。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeCanvas } from './textures.js';

// ---------------------------------------------------------------- fast image-based lighting

// three's PMREM lookup (textureCubeUV: face selection, 2–4 bilinear fetches, per call, twice per pixel) is the single
// most expensive part of a PBR pixel in SwiftShader. fastIBL bakes the PMREM once into a small octahedral atlas (one
// 256² tile per roughness level) and swaps the lookup for two plain fetches. The original chunk is kept for the bake.
const ORIGINAL_CUBE_UV = THREE.ShaderChunk.cube_uv_reflection_fragment;
const IBL_LEVELS = 6, IBL_TILE = 256, IBL_PAD = 2 / 256;
const FAST_CUBE_UV = /* glsl */`
#ifdef ENVMAP_TYPE_CUBE_UV
	// Octahedral atlas: 6 roughness levels in a 2×3 grid of 256² tiles. No trigonometry: SwiftShader is slow at it.
	vec3 kitEnvTile( sampler2D m, vec2 o, float level ) {
		float col = mod( level, 2.0 ), row = floor( level * 0.5 );
		return texture2D( m, vec2( ( col + ${IBL_PAD.toFixed( 6 )} + o.x * ${( 1 - 2 * IBL_PAD ).toFixed( 6 )} ) * 0.5, ( row + ${IBL_PAD.toFixed( 6 )} + o.y * ${( 1 - 2 * IBL_PAD ).toFixed( 6 )} ) / 3.0 ) ).rgb;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 d, float roughness ) {
		d /= abs( d.x ) + abs( d.y ) + abs( d.z );
		vec2 p = d.xz;
		if ( d.y < 0.0 ) p = ( 1.0 - abs( p.yx ) ) * vec2( p.x >= 0.0 ? 1.0 : - 1.0, p.y >= 0.0 ? 1.0 : - 1.0 );
		p = p * 0.5 + 0.5;
		float f = clamp( roughness, 0.0, 1.0 ) * ${( IBL_LEVELS - 1 ).toFixed( 1 )};
		float l0 = floor( f );
		vec3 a = kitEnvTile( envMap, p, l0 );
		if ( f - l0 < 0.02 ) return vec4( a, 1.0 );
		return vec4( mix( a, kitEnvTile( envMap, p, min( l0 + 1.0, ${( IBL_LEVELS - 1 ).toFixed( 1 )} ) ), f - l0 ), 1.0 );
	}
#endif
`;

/**
 * 快速环境光照：把 PMREM 环境贴图烘成一张小的八面体映射图集（每个粗糙度一块 256²，共 512×768 半浮点），并把 three 的环境采样换成两次普通采样。
 * SwiftShader 下 PBR 像素的大头就是环境采样，换掉后 MeshStandardMaterial 每像素约快 2–3 倍，画面几乎一样。
 * 会全局替换本页面的 ShaderChunk.cube_uv_reflection_fragment：之后所有用 scene.environment 的材质都走图集；
 * 不要再把 PMREMGenerator 生成的贴图直接赋给 material.envMap / scene.environment（studioEnvironment / darkEnvironment 已处理）。
 * Fast image-based lighting: bakes a PMREM environment into a small octahedral atlas (one 256² tile per roughness
 * level, 512×768 half float) and replaces three's cube-UV lookup with two plain fetches. The environment lookup is most of a
 * PBR pixel's cost in SwiftShader; this makes MeshStandardMaterial pixels about 2–3× cheaper with near-identical
 * shading. It replaces ShaderChunk.cube_uv_reflection_fragment for the page, so afterwards use only atlases from this
 * function (studioEnvironment / darkEnvironment do) as scene.environment or material.envMap, not raw PMREM textures.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Texture} pmremTexture PMREMGenerator 的结果 / a PMREMGenerator result
 * @returns {THREE.Texture} 图集（mapping 为 CubeUVReflectionMapping，可直接作 scene.environment）/ the atlas, usable as scene.environment
 */
export function fastIBL( renderer, pmremTexture ) {

	const h = pmremTexture.image.height, maxMip = Math.log2( h ) - 2;
	const rt = new THREE.WebGLRenderTarget( IBL_TILE * 2, IBL_TILE * 3, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false } );
	const mat = new THREE.ShaderMaterial( {
		defines: { ENVMAP_TYPE_CUBE_UV: '', CUBEUV_TEXEL_WIDTH: 1 / ( 3 * Math.max( 2 ** maxMip, 7 * 16 ) ), CUBEUV_TEXEL_HEIGHT: 1 / h, CUBEUV_MAX_MIP: maxMip.toFixed( 1 ) },
		uniforms: { envMap: { value: pmremTexture } },
		vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
		fragmentShader: /* glsl */`
			#include <common>
			uniform sampler2D envMap;
			varying vec2 vUv;
			${ORIGINAL_CUBE_UV}
			void main() {
				vec2 g = vUv * vec2( 2.0, 3.0 ), cell = floor( g );
				float level = cell.y * 2.0 + cell.x;
				vec2 o = clamp( ( fract( g ) - ${IBL_PAD.toFixed( 6 )} ) / ${( 1 - 2 * IBL_PAD ).toFixed( 6 )}, 0.0, 1.0 ) * 2.0 - 1.0;
				vec3 d = vec3( o.x, 1.0 - abs( o.x ) - abs( o.y ), o.y );
				if ( d.y < 0.0 ) d.xz = ( 1.0 - abs( d.zx ) ) * vec2( d.x >= 0.0 ? 1.0 : - 1.0, d.z >= 0.0 ? 1.0 : - 1.0 );
				gl_FragColor = textureCubeUV( envMap, normalize( d ), level / ${( IBL_LEVELS - 1 ).toFixed( 1 )} );
			}`,
		depthTest: false, depthWrite: false, toneMapped: false,
	} );
	const quad = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), mat );
	quad.frustumCulled = false;
	const s = new THREE.Scene(); s.add( quad );
	const prev = renderer.getRenderTarget();
	renderer.setRenderTarget( rt );
	renderer.render( s, new THREE.OrthographicCamera() );
	renderer.setRenderTarget( prev );
	mat.dispose(); quad.geometry.dispose();
	THREE.ShaderChunk.cube_uv_reflection_fragment = FAST_CUBE_UV;
	const tex = rt.texture;
	tex.mapping = THREE.CubeUVReflectionMapping;
	tex.name = 'kit-fast-ibl';
	return tex;

}

function bakeEnvironment( renderer, envScene, blur, fast = true ) {

	// PMREM's own shaders include the cube-UV chunk: compile them with the original even after fastIBL swapped it.
	const swapped = THREE.ShaderChunk.cube_uv_reflection_fragment;
	THREE.ShaderChunk.cube_uv_reflection_fragment = ORIGINAL_CUBE_UV;
	const pmrem = new THREE.PMREMGenerator( renderer );
	const pm = pmrem.fromScene( envScene, blur ).texture;
	pmrem.dispose();
	THREE.ShaderChunk.cube_uv_reflection_fragment = swapped;
	return fast === false ? pm : fastIBL( renderer, pm );

}

function softbox( w, h, pos, intensity, tint = 0xffffff, lookAt = [ 0, 0, 0 ] ) {

	const m = new THREE.Mesh( new THREE.PlaneGeometry( w, h ), new THREE.MeshBasicMaterial( { color: new THREE.Color( tint ).multiplyScalar( intensity ), side: THREE.DoubleSide } ) );
	m.position.set( ...pos );
	m.lookAt( ...lookAt );
	return m;

}

/**
 * 影棚环境 / studio environment.
 * RoomEnvironment 加四块柔光箱（左前主柔光、两侧竖灯条、顶光），PMREM 预滤波后作 scene.environment——金属和亮面塑料靠它出“灯条”反射；
 * 另加暖色主光 + 冷色轮廓光两盏平行光。shadow 打开时主光投影（PCF，1024²）。
 * RoomEnvironment plus softboxes (key softbox, two strip lights, top light), PMREM-filtered into scene.environment, so
 * metal and gloss show strip-light reflections; plus a warm key and a cool rim directional light. `shadow` makes the
 * key cast PCF shadows (1024²).
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene 写入 environment 并加入灯光 / receives .environment and the lights
 * @param {{intensity?:number, softboxes?:boolean, key?:number, rim?:number, warm?:boolean, fast?:boolean, shadow?:boolean|{radius?:number, mapSize?:number, bias?:number}}} [o]
 *   fast 快速环境光照（默认 true，见 fastIBL；false 用原版 PMREM，PBR 像素贵 2–3 倍）/ fast IBL (default true, see fastIBL)
 *   intensity 环境强度（默认 1）；key/rim 平行光强度（默认 1.6/1.8；0 关闭）；softboxes 是否加柔光箱（默认 true）；
 *   shadow.radius 投影覆盖半径（世界单位，默认 2）——投影的物体要 castShadow、接收的要 receiveShadow（见 shadowsOn）
 * @returns {{ envMap: THREE.Texture, lights: THREE.Group, key?: THREE.DirectionalLight }}
 * 开销 / cost: 准备时一次 PMREM（约 100 ms），逐帧无额外开销；投影每帧多一遍深度渲染（约 +10–25%）
 *   / one PMREM at setup; shadows add a depth pass per frame (about +10–25%).
 */
export function studioEnvironment( renderer, scene, o = {} ) {

	const env = new RoomEnvironment();
	if ( o.softboxes !== false ) {

		env.add( softbox( 6, 8, [ - 7, 8, 8 ], 6, 0xfff3e2 ) );
		env.add( softbox( 1.2, 14, [ - 10, 4, - 5 ], 10, 0xdfe8ff ) );
		env.add( softbox( 1.2, 14, [ 10, 4, - 3 ], 8, 0xdfe8ff ) );
		env.add( softbox( 9, 9, [ 0, 15, 2 ], 2.5 ) );

	}

	const envMap = bakeEnvironment( renderer, env, 0.03, o.fast );
	scene.environment = envMap;
	scene.environmentIntensity = o.intensity ?? 1;
	const lights = new THREE.Group();
	lights.name = 'studio-lights';
	let key;
	if ( ( o.key ?? 1.6 ) > 0 ) {

		key = new THREE.DirectionalLight( o.warm === false ? 0xffffff : 0xfff1e0, o.key ?? 1.6 );
		key.position.set( - 4, 6, 5 );
		lights.add( key );
		if ( o.shadow ) {

			const s = o.shadow === true ? {} : o.shadow, r = s.radius ?? 2;
			renderer.shadowMap.enabled = true;
			renderer.shadowMap.type = THREE.PCFShadowMap;
			key.castShadow = true;
			key.shadow.mapSize.setScalar( Math.min( 1024, s.mapSize ?? 1024 ) );
			Object.assign( key.shadow.camera, { left: - r, right: r, top: r, bottom: - r, near: 0.1, far: 30 } );
			key.shadow.camera.updateProjectionMatrix();
			key.shadow.bias = s.bias ?? - 0.0004;
			key.shadow.normalBias = 0.01 * r;
			key.shadow.radius = 3;

		}

	}

	if ( ( o.rim ?? 1.8 ) > 0 ) {

		const rim = new THREE.DirectionalLight( 0xbcd0ff, o.rim ?? 1.8 );
		rim.position.set( 5, 3, - 5 );
		lights.add( rim );

	}

	scene.add( lights );
	return { envMap, lights, key };

}

/** 给子树所有网格打开投影/接收投影 / set castShadow / receiveShadow on every mesh in a subtree. */
export function shadowsOn( object, cast = true, receive = true ) {

	object.traverse( ( m ) => {

		if ( m.isMesh && ! m.userData.noShadow ) {

			m.castShadow = cast; m.receiveShadow = receive;

		}

	} );
	return object;

}

/**
 * 暗环境 / dark environment: 黑色四周 + 一个小而亮的光源方向亮斑（金属/锡箔上的锐利高光）+ 对侧微弱冷色补光；另加一盏同方向平行光。
 * 用于夜景、虚空背景、单灯戏剧光。Black surround, a small bright light disc (sharp glints on metal and foil), a faint cool
 * fill from the opposite side, plus a matching directional light. For night, void backgrounds and single-light drama.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {{light?:number[], intensity?:number, fill?:number, envIntensity?:number, color?:THREE.ColorRepresentation, fast?:boolean}} [o]
 *   light 光源方向（默认 [-1, 0.6, 0.8]）；intensity 平行光强度（默认 3.2）；fill 补光倍数（默认 1）
 * @returns {{ envMap: THREE.Texture, light: THREE.DirectionalLight }}
 */
export function darkEnvironment( renderer, scene, o = {} ) {

	const dir = new THREE.Vector3( ...( o.light ?? [ - 1, 0.6, 0.8 ] ) ).normalize();
	const env = new THREE.Scene();
	env.add( new THREE.Mesh( new THREE.SphereGeometry( 20, 16, 8 ), new THREE.MeshBasicMaterial( { color: 0x020306, side: THREE.BackSide } ) ) );
	env.add( softbox( 3, 3, dir.clone().multiplyScalar( 15 ).toArray(), 60, o.color ?? 0xfff6e8 ) );
	env.add( softbox( 26, 14, dir.clone().multiplyScalar( - 14 ).setY( - 6 ).toArray(), 0.35 * ( o.fill ?? 1 ), 0x6f8fbf ) );
	env.add( softbox( 20, 20, [ 0, 18, 0 ], 0.12 * ( o.fill ?? 1 ), 0xbfd0ff ) );
	const envMap = bakeEnvironment( renderer, env, 0.02, o.fast );
	scene.environment = envMap;
	scene.environmentIntensity = o.envIntensity ?? 1;
	const light = new THREE.DirectionalLight( o.color ?? 0xfff4e6, o.intensity ?? 3.2 );
	light.position.copy( dir ).multiplyScalar( 10 );
	scene.add( light );
	return { envMap, light };

}

const SHADOW_VERT = /* glsl */`
#include <common>
varying float vKitY;
void main() {
	#include <begin_vertex>
	#include <project_vertex>
	vec4 wp = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		wp = instanceMatrix * wp;
	#endif
	vKitY = ( modelMatrix * wp ).y;
}`;
const SHADOW_FRAG = /* glsl */`
uniform float y0; uniform float fade;
varying float vKitY;
void main() { gl_FragColor = vec4( 1.0 - clamp( ( vKitY - y0 ) / fade, 0.0, 1.0 ) ); }`;

/**
 * 接触阴影（烘焙一次）/ baked contact shadow.
 * 从地面下方正交渲染物体剪影（离地越近越黑），CPU 上用 canvas blur 做一紧一松两层模糊，贴在一个透明平面上。
 * Renders the object's silhouette from below (darker where closer to the ground), blurs it twice on a canvas
 * (tight contact + soft spread) and puts it on a transparent plane at the object's base.
 * 物体移动/形变后调用 mesh.userData.update() 重烘焙（约 10–20 ms）；只绕竖直轴转动时可把平面挂在物体下面一起转。
 * Call mesh.userData.update() after the object moves (≈10–20 ms); for a turntable, parent the plane to the object.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D} object 投影物体（世界矩阵需已更新）/ caster (world matrices up to date)
 * @param {{size?:number, resolution?:number, blur?:number, opacity?:number, fade?:number, y?:number}} [o]
 *   size 平面边长（默认物体包围盒最大边 × 1.6）；fade 多高之内投影（默认包围盒高 × 0.5）；y 平面高度（默认包围盒底 + 0.001）
 * @returns {THREE.Mesh} 2 个三角形 / 2 triangles
 */
export function contactShadow( renderer, object, o = {} ) {

	const res = o.resolution ?? 256;
	const rt = new THREE.WebGLRenderTarget( res, res );
	const mat = new THREE.ShaderMaterial( { vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG, uniforms: { y0: { value: 0 }, fade: { value: 1 } }, side: THREE.DoubleSide } );
	const tex = new THREE.CanvasTexture( makeCanvas( res, res ) );
	tex.colorSpace = THREE.NoColorSpace;
	const plane = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ).rotateX( - Math.PI / 2 ), new THREE.MeshBasicMaterial( { color: 0x000000, transparent: true, depthWrite: false, alphaMap: tex, opacity: o.opacity ?? 0.75 } ) );
	plane.name = 'contact-shadow';
	plane.renderOrder = 2;
	plane.userData.noReflect = true;
	plane.userData.noShadow = true;

	const update = () => {

		object.updateWorldMatrix( true, true );
		const box = new THREE.Box3().setFromObject( object );
		const c = box.getCenter( new THREE.Vector3() ), sz = box.getSize( new THREE.Vector3() );
		const size = o.size ?? Math.max( sz.x, sz.z ) * 1.6;
		const y = o.y ?? box.min.y + 0.001;
		mat.uniforms.y0.value = y;
		mat.uniforms.fade.value = o.fade ?? Math.max( 1e-3, sz.y * 0.5 );
		const cam = new THREE.OrthographicCamera( - size / 2, size / 2, size / 2, - size / 2, 0, sz.y + 1 );
		cam.up.set( 0, 0, 1 );
		cam.position.set( c.x, y - 0.0005, c.z );
		cam.lookAt( c.x, y + 1, c.z );
		cam.updateMatrixWorld();

		// Draw only the caster, with the shadow material, into the render target.
		const tmp = new THREE.Scene();
		tmp.overrideMaterial = mat;
		const proxy = new THREE.Group();
		proxy.matrixAutoUpdate = false;
		const parent = object.parent;
		tmp.add( proxy );
		proxy.add( object );
		proxy.matrix.copy( parent ? parent.matrixWorld : new THREE.Matrix4() );
		proxy.matrixWorldNeedsUpdate = true;
		const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor( new THREE.Color() ), prevAlpha = renderer.getClearAlpha();
		const prevShadow = renderer.shadowMap.autoUpdate;
		renderer.shadowMap.autoUpdate = false;
		renderer.setRenderTarget( rt );
		renderer.setClearColor( 0x000000, 0 );
		renderer.clear();
		renderer.render( tmp, cam );
		renderer.setRenderTarget( prevRT );
		renderer.setClearColor( prevClear, prevAlpha );
		renderer.shadowMap.autoUpdate = prevShadow;
		if ( parent ) parent.add( object ); else proxy.remove( object );

		const px = new Uint8Array( res * res * 4 );
		renderer.readRenderTargetPixels( rt, 0, 0, res, res, px );
		const src = makeCanvas( res, res ), sg = src.getContext( '2d' ), img = sg.createImageData( res, res );
		for ( let i = 0; i < res * res; i ++ ) {

			const v = px[ i * 4 ];
			img.data[ i * 4 ] = img.data[ i * 4 + 1 ] = img.data[ i * 4 + 2 ] = v; img.data[ i * 4 + 3 ] = 255;

		}

		sg.putImageData( img, 0, 0 );
		const blur = o.blur ?? 1;
		const dst = tex.image, g = dst.getContext( '2d' );
		g.filter = 'none';
		g.fillStyle = '#000'; g.fillRect( 0, 0, res, res );
		g.globalCompositeOperation = 'lighter';
		g.globalAlpha = 0.6; g.filter = `blur(${( res / 90 ) * blur}px)`; g.drawImage( src, 0, 0 );
		g.globalAlpha = 0.55; g.filter = `blur(${( res / 22 ) * blur}px)`; g.drawImage( src, 0, 0 );
		g.globalAlpha = 1; g.filter = 'none'; g.globalCompositeOperation = 'source-over';
		tex.needsUpdate = true;

		plane.scale.set( size, 1, size );
		plane.position.set( c.x, y, c.z );
		if ( plane.parent && plane.parent !== object.parent ) plane.parent.worldToLocal( plane.position );

	};

	update();
	plane.userData.update = update;
	return plane;

}

/**
 * 廉价 AO 阴影斑：径向渐变的透明黑色平面，放在物体脚下。不需要渲染，随物体移动只改位置/缩放。
 * Cheap ambient-occlusion blob: a transparent radial-gradient plane under an object. No rendering; move or scale it freely.
 * @param {{radius?:number, opacity?:number, softness?:number, scale?:number[], y?:number}} [o]
 *   radius 半径（默认 0.5）；opacity（默认 0.6）；softness 0..1 外圈柔和程度（默认 0.7）；scale [x,z] 椭圆拉伸
 * 三角形 / triangles: 2
 * @returns {THREE.Mesh}
 */
export function blobShadow( o = {} ) {

	const N = 128, c = makeCanvas( N ), g = c.getContext( '2d' ), soft = o.softness ?? 0.7;
	const grd = g.createRadialGradient( N / 2, N / 2, 0, N / 2, N / 2, N / 2 );
	grd.addColorStop( 0, 'rgba(255,255,255,1)' );
	grd.addColorStop( Math.max( 0.05, 1 - soft ), 'rgba(255,255,255,0.75)' );
	grd.addColorStop( Math.min( 0.95, 1 - soft * 0.45 ), 'rgba(255,255,255,0.25)' );
	grd.addColorStop( 1, 'rgba(255,255,255,0)' );
	g.fillStyle = '#000'; g.fillRect( 0, 0, N, N );
	g.fillStyle = grd; g.fillRect( 0, 0, N, N );
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.NoColorSpace;
	const r = o.radius ?? 0.5, [ sx, sz ] = o.scale ?? [ 1, 1 ];
	const m = new THREE.Mesh( new THREE.PlaneGeometry( 2 * r * sx, 2 * r * sz ).rotateX( - Math.PI / 2 ), new THREE.MeshBasicMaterial( { color: 0x000000, alphaMap: tex, transparent: true, depthWrite: false, opacity: o.opacity ?? 0.6 } ) );
	m.position.y = o.y ?? 0.001;
	m.renderOrder = 2;
	m.name = 'blob-shadow';
	m.userData.noReflect = true;
	m.userData.noShadow = true;
	return m;

}

const GROUND_VERT = /* glsl */`
varying vec3 vKitPos;
varying vec4 vKitRefl;
uniform mat4 kitReflMat;
void main() {
	vKitPos = position;
	vKitRefl = kitReflMat * vec4( position, 1.0 );
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const GROUND_FRAG = /* glsl */`
uniform vec3 kitColor; uniform vec4 kitShape; uniform vec3 kitReflP; uniform sampler2D kitRefl;
varying vec3 vKitPos; varying vec4 vKitRefl;
void main() {
	float r = length( vKitPos.xz );
	vec3 c = kitColor * ( 1.0 + kitShape.z * ( 1.0 - smoothstep( 0.0, kitShape.w, r ) ) );
	#ifdef KIT_REFLECT
		vec2 ruv = vKitRefl.xy / vKitRefl.w;
		vec2 px = kitReflP.yz;
		vec4 rf = texture2D( kitRefl, ruv ) * 0.36 + ( texture2D( kitRefl, ruv + px ) + texture2D( kitRefl, ruv - px )
			+ texture2D( kitRefl, ruv + vec2( px.x, - px.y ) ) + texture2D( kitRefl, ruv + vec2( - px.x, px.y ) ) ) * 0.16;
		#ifdef TONE_MAPPING
			rf.rgb = toneMapping( rf.rgb );
		#endif
		c = mix( c, rf.rgb, clamp( rf.a, 0.0, 1.0 ) * kitReflP.x );
	#endif
	gl_FragColor = vec4( c, 1.0 - smoothstep( kitShape.x, kitShape.y, r ) );
	#include <colorspace_fragment>
}`;

/**
 * 地面：不受光的便宜着色器（整屏 PBR 地面在软件渲染下要几百毫秒），颜色直接按显示色给（与 scene.background 同色即无缝），
 * 中心略亮、边缘按透明度渐隐；reflection>0 时加一层轻微的模糊平面倒影（半分辨率再画一遍镜像场景）。阴影用 contactShadow / blobShadow 叠在上面。
 * Ground with a cheap unlit shader (a full-screen PBR floor costs hundreds of ms in software rendering). `color` is the
 * displayed colour (equal to scene.background = seamless), slightly brighter in the middle, alpha-faded at the edge;
 * reflection > 0 adds a subtle blurred planar reflection (the mirrored scene drawn again at reduced resolution).
 * Put contactShadow / blobShadow on top for grounding.
 * @param {THREE.WebGLRenderer} renderer
 * @param {{radius?:number, y?:number, color?:THREE.ColorRepresentation, glow?:number, reflection?:number, resolution?:number, blur?:number, fade?:number[]}} [o]
 *   radius 半径（默认 6）；color 显示色（默认 0xb8b4ae）；glow 中心提亮（默认 0.06）；reflection 倒影强度 0..1（默认 0.2，0 关闭最省）；
 *   resolution 倒影分辨率比例（默认 0.5）；blur 倒影模糊像素（默认 2）；fade [内半径, 外半径] 渐隐（默认 [0.35, 0.95]×radius）
 * 三角形 / triangles: 128；倒影 = 再画一遍场景（物体三角形 ×2，像素 ×0.25）/ the reflection redraws the scene at ¼ pixels.
 * 开销 / cost: 地面本身很便宜；reflection 开时约 +20–40% 帧时间 / the floor is cheap; reflection adds about 20–40%.
 * 被标 userData.noReflect 的物体（接触阴影、阴影斑）不进倒影。/ objects with userData.noReflect are skipped.
 * @returns {THREE.Mesh}
 */
export function ground( renderer, o = {} ) {

	const R = o.radius ?? 6, fade = o.fade ?? [ 0.35 * R, 0.95 * R ];
	const strength = o.reflection ?? 0.2;
	const color = new THREE.Color( o.color ?? 0xb8b4ae );
	const uniforms = {
		kitColor: { value: color },
		kitShape: { value: new THREE.Vector4( fade[ 0 ], fade[ 1 ], o.glow ?? 0.06, R * 0.5 ) },
		kitReflMat: { value: new THREE.Matrix4() },
		kitReflP: { value: new THREE.Vector3() },
		kitRefl: { value: null },
	};
	const mat = new THREE.ShaderMaterial( { vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, uniforms, transparent: true, defines: strength > 0 ? { KIT_REFLECT: '' } : {} } );
	const mesh = new THREE.Mesh( new THREE.CircleGeometry( R, 64 ).rotateX( - Math.PI / 2 ), mat );
	mesh.name = 'ground';
	mesh.position.y = o.y ?? 0;
	mesh.renderOrder = - 1;
	mesh.userData.noReflect = true;
	mesh.userData.noShadow = true;
	if ( strength > 0 ) {

		const size = renderer.getDrawingBufferSize( new THREE.Vector2() ).multiplyScalar( o.resolution ?? 0.5 ).floor();
		const rt = new THREE.WebGLRenderTarget( size.x, size.y, { type: THREE.HalfFloatType } );
		uniforms.kitRefl.value = rt.texture;
		uniforms.kitReflP.value.set( strength, ( o.blur ?? 2 ) / size.x, ( o.blur ?? 2 ) / size.y );

		const virtualCamera = new THREE.PerspectiveCamera();
		const plane = new THREE.Plane(), normal = new THREE.Vector3(), wp = new THREE.Vector3(), cp = new THREE.Vector3();
		const rot = new THREE.Matrix4(), look = new THREE.Vector3(), view = new THREE.Vector3(), target = new THREE.Vector3();
		const clip = new THREE.Vector4(), q = new THREE.Vector4(), bias = new THREE.Matrix4().set( 0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1 );
		const hidden = [], prevClear = new THREE.Color();
		mesh.onBeforeRender = ( r, scene, camera ) => {

			wp.setFromMatrixPosition( mesh.matrixWorld );
			cp.setFromMatrixPosition( camera.matrixWorld );
			rot.extractRotation( mesh.matrixWorld );
			normal.set( 0, 1, 0 ).applyMatrix4( rot );
			view.subVectors( wp, cp );
			if ( view.dot( normal ) > 0 ) return; // camera below the ground
			view.reflect( normal ).negate().add( wp );
			rot.extractRotation( camera.matrixWorld );
			look.set( 0, 0, - 1 ).applyMatrix4( rot ).add( cp );
			target.subVectors( wp, look ).reflect( normal ).negate().add( wp );
			virtualCamera.position.copy( view );
			virtualCamera.up.set( 0, 1, 0 ).applyMatrix4( rot ).reflect( normal );
			virtualCamera.lookAt( target );
			virtualCamera.far = camera.far;
			virtualCamera.updateMatrixWorld();
			virtualCamera.projectionMatrix.copy( camera.projectionMatrix );
			uniforms.kitReflMat.value.copy( bias ).multiply( virtualCamera.projectionMatrix ).multiply( virtualCamera.matrixWorldInverse ).multiply( mesh.matrixWorld );
			// Oblique near plane = the ground plane, so nothing below it shows up in the reflection.
			plane.setFromNormalAndCoplanarPoint( normal, wp ).applyMatrix4( virtualCamera.matrixWorldInverse );
			clip.set( plane.normal.x, plane.normal.y, plane.normal.z, plane.constant );
			const pm = virtualCamera.projectionMatrix;
			q.x = ( Math.sign( clip.x ) + pm.elements[ 8 ] ) / pm.elements[ 0 ];
			q.y = ( Math.sign( clip.y ) + pm.elements[ 9 ] ) / pm.elements[ 5 ];
			q.z = - 1.0; q.w = ( 1.0 + pm.elements[ 10 ] ) / pm.elements[ 14 ];
			clip.multiplyScalar( 2.0 / clip.dot( q ) );
			pm.elements[ 2 ] = clip.x; pm.elements[ 6 ] = clip.y; pm.elements[ 10 ] = clip.z + 1.0; pm.elements[ 14 ] = clip.w;

			hidden.length = 0;
			scene.traverseVisible( ( c ) => {

				if ( c.userData.noReflect ) hidden.push( c );

			} );
			for ( const c of hidden ) c.visible = false;
			const prevRT = r.getRenderTarget(), prevBg = scene.background, prevShadow = r.shadowMap.autoUpdate;
			r.getClearColor( prevClear );
			const prevAlpha = r.getClearAlpha();
			scene.background = null;
			r.shadowMap.autoUpdate = false;
			r.setRenderTarget( rt );
			r.setClearColor( 0x000000, 0 );
			r.clear();
			r.render( scene, virtualCamera );
			r.setRenderTarget( prevRT );
			r.setClearColor( prevClear, prevAlpha );
			scene.background = prevBg;
			r.shadowMap.autoUpdate = prevShadow;
			for ( const c of hidden ) c.visible = true;

		};

	}

	return mesh;

}

/**
 * 只显示阴影的地面层（ShadowMaterial），配合 studioEnvironment({ shadow }) 的投影主光，叠在 ground 上。
 * Shadow-only ground layer (ShadowMaterial) for a shadow-casting key light; lay it over ground().
 * @param {{radius?:number, opacity?:number, y?:number}} [o] 默认半径 3、不透明度 0.35
 * 开销 / cost: 每个覆盖像素一次阴影贴图 PCF 采样 / one PCF shadow lookup per covered pixel.
 * @returns {THREE.Mesh}
 */
export function shadowCatcher( o = {} ) {

	const m = new THREE.Mesh( new THREE.CircleGeometry( o.radius ?? 3, 48 ).rotateX( - Math.PI / 2 ), new THREE.ShadowMaterial( { opacity: o.opacity ?? 0.35, depthWrite: false } ) );
	m.position.y = ( o.y ?? 0 ) + 0.0005;
	m.receiveShadow = true;
	m.renderOrder = 1;
	m.name = 'shadow-catcher';
	m.userData.noReflect = true;
	m.userData.noShadow = true;
	return m;

}

/**
 * 统计三角形数（含 InstancedMesh 实例数，只算可见网格）/ count triangles in an object tree (instances included, visible only).
 * @param {THREE.Object3D} object
 */
export function countTriangles( object ) {

	let n = 0;
	object.traverseVisible( ( o ) => {

		if ( ! o.isMesh ) return;
		const g = o.geometry;
		const per = ( g.index ? g.index.count : g.attributes.position.count ) / 3;
		n += per * ( o.isInstancedMesh ? o.count : 1 );

	} );
	return Math.round( n );

}

/**
 * window.__three 约定：渲染系统据此统计每帧三角形数、贴图数、网格数（复杂度检查）。建好渲染器和场景后调用一次。
 * The window.__three convention: the renderer reads it to measure triangles, textures and meshes per frame. Call once
 * after creating the renderer and scene.
 * @param {THREE.WebGLRenderer} renderer @param {THREE.Scene} scene @param {THREE.Camera} [camera]
 * @returns {{renderer:THREE.WebGLRenderer, scene:THREE.Scene, camera?:THREE.Camera}}
 */
export function exposeThree( renderer, scene, camera ) {

	const t = { renderer, scene, camera };
	window.__three = t;
	return t;

}
