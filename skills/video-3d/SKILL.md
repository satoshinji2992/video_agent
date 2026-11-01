---
name: video-3d
description: 用 three.js 在 render_code_shot 的 HTML 里做真 3D 镜头：产品转台、环绕推近、爆炸图、地形飞越、三维数据图表、标志揭示、地质勘探（地形+矿体+钻孔）。现实里有的物体先用 find_model/use_model 取现成的 glTF 模型；没有的用细节工具（kit）精细建模。需要立体物体、真实光影材质或三维运镜时使用；页面从 /vendor/three/ 引入内置的 three.js，画面逐帧由 t 决定，不联网。
---

# video-3d：three.js 三维镜头

三维镜头仍然走 `render_code_shot`：交一个完整 HTML，定义 `window.renderFrame(t)`。区别只是页面可以从
`/vendor/three/` 引入内置的 three.js（r186 / 0.186.1）。这是唯一的例外，其他网络请求一律被拦截。
系统以 **2 倍像素**渲染三维镜头（`window.devicePixelRatio = 2`），编码时再缩小：这就是抗锯齿，页面必须 `renderer.setPixelRatio(window.devicePixelRatio)`。

**先挑 `templates/` 里最接近的模板读一遍，在它上面改内容和运镜**，比从零写稳。每个模板横竖版都能直接用，画面精细度和耗时都已调过。

最快的做法（用户在等，构思时间越短越好）：只读一个最接近的模板，不要把几个模板都读一遍。**场景框架**照模板来：整页结构、准备阶段、灯光/烘焙、渲染器设置、构图和运镜函数原样保留，参数区（`DURATION`、配色、文字、相机路径）按需要改；不要把模板里的便宜做法换回"标准"做法（例如把 matcap 换回 MeshStandard、加 DirectionalLight、加 UnrealBloom），那样每帧开销会翻倍。
**主体**（画面中心那个东西）要精细，可以也应该花功夫：
1. 现实里有的东西（家具、工具、食物、植物、航天器、火星车、望远镜、行星……）先用 `find_model` 找现成模型，`use_model` 下载后在页面里加载（见"现成模型"）。现成模型的细节比程序化建模高一个量级。
2. 找不到合适的，就用细节工具 `kit` 程序化精细建模（见"细节工具"）：表面位移 + 法线贴图、倒角、接缝、螺栓、线缆、材质预设，不要用光秃秃的球、方块、圆柱当主体。
3. 渲染结果会报告场景的三角形数、网格数和没有贴图的纯色网格数；主体只有几千面、没有贴图，系统会提示你加细节。

| 模板 | 内容 | 用到的技法 |
|---|---|---|
| `templates/product-turntable.html` | 产品转台（棚拍） | 圆角轮廓 Lathe（瓶底倒角、圆肩、瓶颈螺纹）；自建影棚 PMREM → 用 PBR 球烘成 matcap（清漆陶瓷、抛光/拉丝金属按遮罩混合）；画布标签 + 压纹法线；模板缓冲台面倒影、接触阴影贴图、顶点色 AO；AnimationMixer 开盖；结尾标签正对镜头 |
| `templates/camera-orbit-pushin.html` | 环绕推近（蓝调城市） | MeshBasic + onBeforeCompile 注入顶点光照和高度雾；着色器画楼窗；扭转塔 + 烘焙立方体贴图反射；天空与雾同一公式；光晕管/光晕精灵代替泛光；mip 偏移做景深感；乘法混合的全屏压暗网格（暗角、标题衬底） |
| `templates/exploded-view.html` | 爆炸图（手机六层） | 倒角 Extrude 外壳/中框；RoundedBox 元件 + InstancedMesh 贴片；JS 积分的 HDR matcap（`lit()`，参数同 MeshStandard）；层间软阴影烘进贴图；画布 UI/PCB + 法线贴图；每帧投影包围盒自动取景（`SAFE`）；HTML/SVG 引线标签 |
| `templates/terrain-flyover.html` | 地形飞越 | 带种子值噪声（脊状 + 侵蚀 + 冲沟 + 河谷）；烘焙坡度/曲率/山影/AO 贴图，逐像素按贴图混合岩/草/林/雪；平铺细节贴图；菲涅尔水面；天空、雾、水面同一公式；分块 LOD + 裙边；样条匀速飞行 |
| `templates/data-chart-3d.html` | 三维柱状图 | 自写圆角柱（只拉中段，圆角不变形）；自写亮面着色器（解析影棚反射 + 菲涅尔 + 轮廓光）；镜像倒影 + 接触阴影；按屏幕像素生成的描边文字精灵；刻度标签避让标题；高亮扫色 |
| `templates/logo-reveal.html` | 标志揭示 | TextGeometry 圆倒角 + 折痕法线；拉丝金字面/抛光倒角（程序化粗糙度和法线）；影棚 PMREM + MeshStandard；烧入边 + 粒子自发光；1/8 分辨率自制辉光；镜面地台倒影；虚化光斑 |
| `templates/geology-exploration.html` | 地质勘探 | 光照烘进贴图的地表/剖面（MeshBasic）；褶皱 + 断层地层剖面贴图；分级品位壳矿体着色器；钻孔岩芯分段着色 + 钻机；标签自动避让；每帧自动取景（`AREA`） |

## 快速开始（页面骨架，必须照做）

```html
<style>
  /* 背景、柔光、暗角都写在 body 背景里（画在透明画布下面，不占渲染时间） */
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden;
    background: radial-gradient(120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,.5) 100%), radial-gradient(60% 45% at 50% 42%, #2a3550, #0a0d14); }
  canvas { display: block; position: fixed; inset: 0; }
</style>
<script type="importmap">
{ "imports": { "three": "/vendor/three/build/three.module.js", "three/addons/": "/vendor/three/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
let draw;
window.sceneReady = (async () => {
  await document.fonts.load('700 64px "Noto Sans CJK SC"', '中文');   // 先等字体，再画画布文字
  const W = innerWidth, H = innerHeight, DPR = window.devicePixelRatio || 1; // W×H 是 CSS 尺寸；DPR 平时是 2
  const renderer = new THREE.WebGLRenderer({ antialias: DPR < 2, alpha: true, preserveDrawingBuffer: true }); // 2 倍时不开 MSAA
  renderer.setPixelRatio(DPR); renderer.setSize(W, H);               // 写死 1 = 超采样白做，边缘锯齿
  renderer.setClearColor(0, 0);                                      // 透明，露出 CSS 背景
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  document.body.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  window.__three = { renderer, scene };                              // 必须挂：系统据此统计三角形数和贴图数，没挂会提示"无法统计面数"
  // 影棚环境：暗房间 + 几块发光灯箱（转台模板 studio()），PMREM 只要 size 64，再把材质烘成 matcap（bake()）
  const envTex = new THREE.PMREMGenerator(renderer).fromScene(studio(), 0.02, 0.1, 100, { size: 64 }).texture;
  // ……同步建好整个场景、相机……
  draw = (t) => { /* 全部状态由 t 算出 */ renderer.render(scene, camera); };
  renderer.compile(scene, camera);                                   // 同步编译着色器（compileAsync 在软件渲染下可能空等 5–10 秒）
  draw(0);                                                           // 预热一帧：上传贴图
})();
window.renderFrame = async (t) => { await window.sceneReady; draw(t); };
</script>
```

- `window.renderFrame` 必须在模块里**同步**赋值（页面 load 后系统马上检查它）。系统随后会等待 `window.sceneReady`（最多 30 秒），
  再逐帧调用 renderFrame 并截图；单帧超过 5 秒直接失败，所以字体、贴图生成、烘焙、着色器编译这些一次性工作都放进 sceneReady。
- **可用模块**（只有这些，别的 addon 不存在）：`three`；`three/addons/` 下的
  `environments/RoomEnvironment.js`、`objects/Sky.js`、`postprocessing/{EffectComposer,RenderPass,UnrealBloomPass,OutputPass,ShaderPass,FXAAPass}.js`、
  `geometries/{TextGeometry,RoundedBoxGeometry}.js`、`loaders/{FontLoader,GLTFLoader,DRACOLoader}.js`、`libs/meshopt_decoder.module.js`、
  `utils/{BufferGeometryUtils,SkeletonUtils}.js`、`math/{SimplexNoise,ImprovedNoise}.js`，以及细节工具 `/vendor/kit3d/index.js`；
  拉丁字体 `/vendor/three/examples/fonts/helvetiker_bold.typeface.json`。没有 OrbitControls。模型只能从本会话的 `/assets/` 加载（`use_model` 下载的 .glb），不能联网。
  后期通道模块虽然在，但全屏通道在软件渲染下太贵，别用（见性能预算）。
- 字体 JSON 用静态导入：`import fontJson from '/vendor/three/examples/fonts/helvetiker_bold.typeface.json' with { type: 'json' };`，
  再 `new FontLoader().parse(fontJson)`；不要 `FontLoader.load`。上传的图片用 `<img src="assets/xx.png">` 写进页面，再 `new THREE.Texture(img)` 并设 `needsUpdate = true`。

## 现成模型（find_model / use_model）

- `find_model` 用英文搜（"office chair"、"potted plant"、"Perseverance rover"），看缩略图和"是什么"挑；`use_model` 下载后返回文件名、三角形数、原尺寸和四个方向的预览——先看预览确认朝向。
- 下载的模型已经减面（默认 ≤ 15 万三角形）、贴图 ≤ 2048、居中并缩放到半径 1 以内；场景里按需要缩放、旋转摆正。
- 加载（放进 sceneReady）：
```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const loader = new GLTFLoader()
  .setDRACOLoader(new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/'))  // 必须写这个路径，默认路径不存在
  .setMeshoptDecoder(MeshoptDecoder);
const model = (await loader.loadAsync('/assets/md-polyhaven-xxxx.glb')).scene;
scene.add(model);
```
- 模型自带 PBR 贴图，用 `scene.environment`（影棚 PMREM）照亮就有质感；带贴图的实时 PBR 在软件渲染下贵，满屏大特写可能超预算（系统会自动退回 1 倍超采样）。
  主体占画面一半左右、环境 `size: 64`、不加后期，通常能守住预算。
- **品牌字样**：现成模型常带真实品牌的字样或标志（镜头圈、铭牌、标签上的 LOGO）。`find_model` 把名称里带品牌的标出来排在后面，`use_model` 会检查贴图并点名看到的字样。
  做广告和通用展示时，带品牌的模型默认不用，换一个结果；实在只有它能用，就把带字的部件转到背面、不给特写，或者在页面里把那块贴图换掉（traverse 找到对应材质，map 换成纯色或自己画的标签），并主动告诉用户。不要把别人的牌子当成用户的产品。
- **署名和真实性**：用了模型的镜头，角标和片尾署名自动加上。通用模型只是"长得像"，角标写"三维示意"，口播不要说成就是那个真实物体；
  只有 `use_model` 标了"实测形状"的，才能说就是它，而且只能当它本身用（某颗小行星的形状模型不能拿来演另一颗）。

## 细节工具（kit）

`import * as kit from '/vendor/kit3d/index.js'`，全部带种子、确定性。常用：
- 表面细节（岩石、树皮、面包、陶土、地形）：`kit.detailSurface(geometry, 'rock' | 'stone' | 'bark' | 'crust' | 'clay' | 'terrain', { seed })`；
  底层是 `kit.displace(geo, { amplitude, scale, ridged, pits, cells, grooves })` + `kit.surfaceMaps(...)` / `kit.triplanarDetail(material, …)`。
- 硬表面：`kit.roundedBox` / `kit.roundedCylinder`（倒角）、`kit.seams(material, [...])`（接缝线，不需要 UV）、`kit.bolts(points, { kind, recess })`（实例化螺丝）、
  `kit.cable({ from, to, sag })`（线缆垂到地面）、`kit.grille` / `kit.louvers` / `kit.perforationMaps`（格栅、百叶、打孔）。
- 材质预设：`kit.material('metal:brushed' | 'plastic:textured' | 'glass:frosted' | 'fabric:canvas' | 'foil' | 'wood' | 'ceramic:glossy' | 'rubber:knurl', { color })`。
- 标签和贴花：`await kit.labelTexture({ width, height, lines: [...] })`（支持中文）+ `kit.decal(tex, { curve })`。
- 场景：`kit.studioEnvironment(renderer, scene)`（影棚环境 + 灯箱 + 轮廓光）、`kit.contactShadow` / `kit.blobShadow`、`kit.ground(renderer, { reflection })`、
  `kit.exposeThree(renderer, scene, camera)`（挂 `window.__three`）。
- 注意：`kit.fastIBL` 会替换整页的一段着色器，用了它就只用 kit 做的环境，不要再把 PMREMGenerator 的原始贴图直接给材质；地面倒影会把场景多画一遍，紧张时 `reflection: 0`。

## 确定性

- 不用 requestAnimationFrame、setTimeout、`THREE.Clock`、Date.now、performance.now、CSS 动画。
- 随机数全部用带种子的 PRNG（模板里的 `mulberry32(seed)`）；`new SimplexNoise({ random: mulberry32(seed) })`，不传参数就会用 Math.random。
- draw(t) 只根据 t 设置位置、旋转、透明度、uniform 等，再同步 `renderer.render`，不要依赖上一帧累积的状态。
- 关键帧/骨骼动画：照常建 `AnimationClip` + `KeyframeTrack`、`mixer.clipAction(clip).play()`，但每帧调用 `mixer.setTime(t)` 跳到 t，
  不要 `mixer.update(delta)`。一次性动作设 `action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true`（见转台模板）。
- 画布：`setPixelRatio(window.devicePixelRatio)`，`setSize` 用 CSS 尺寸（竖版 480×854、横版 854×480、方形 480×480），`preserveDrawingBuffer: true`。
  所有按设备像素算的东西（自制辉光的渲染目标、画布文字的像素尺寸、着色器里的 `gl_FragCoord`）都要乘 DPR。
- 着色器只编译当时可见的物体：在第一次 draw 之前、所有物体都可见时调用 `renderer.compile`；后面才出现的物体先临时设 visible 再编译（见地质模板）。
  同一材质不要在透明/不透明之间切换（会多编译一个着色器）。

## 构图与文字

- `fitDistance(半径, camera)` 让主体横竖版都放得下；`camera.setViewOffset(W, H, dx, dy, W, H)` 平移构图（dx 为负主体右移，dy 为正主体上移）。
  竖版底部约 20% 留给字幕，主体略上移；横版常把文字放左、主体放右。用 `W > H` 分别调。
- 主体会展开或移动时，每帧把它包围盒的角点投影到屏幕，反算相机距离和平移，让它落在一个安全框里（爆炸图 `fitCamera`/`SAFE`、地质 `AREA`）。
  横竖版都要从头到尾抽帧检查：主体不出框、不压标题；产品的正面在结尾要正对镜头。
- **屏幕文字**（标题、说明、图例、引线标签）用 HTML/SVG 叠层：字体 `"Noto Sans CJK SC"`，在 draw(t) 里改 opacity/transform。
  超采样下最锐利；引线用 SVG，锚点每帧由三维点 `project(camera)` 算出（爆炸图）。
- **贴在三维物体上的中文**：画布贴图，`tex.colorSpace = THREE.SRGBColorSpace`。画布按**屏幕上的实际像素**生成（世界尺寸 × 每单位像素 × DPR，见柱状图 `textSprite`），
  深色描边，`generateMipmaps = false`、`minFilter = LinearFilter`。始终朝向相机的标签用 `Sprite`（`depthTest: false`），贴在表面的用 `PlaneGeometry` + `MeshBasicMaterial({ map, transparent: true })`。
  动态数字每帧重画并设 `tex.needsUpdate = true`（数值没变就不重画）。
- **拉丁字母立体字**：`TextGeometry`（仅 helvetiker 粗体，不含中文），`computeBoundingBox()` 后平移居中。用户没给品牌名就用占位词（如 LOGO），不要自编名字。

## 精细度（自己写的三维镜头逐条照做）

用户嫌"粗糙"，就是缺了下面这些。模板都做到了；自己写时每条都要有，括号里是这套软件渲染下最便宜的做法。

1. **倒角和圆角**：没有绝对锐利的边，倒角上的高光线是精致感的主要来源。回转体轮廓用圆角折线（转台 `rounded()`）；
   平面轮廓 `ExtrudeGeometry` 开 `bevelEnabled`（`bevelSegments: 1` 是机加工 45° 棱，≥3 是圆润弧边）；立体字 `bevelSegments: 5` + `toCreasedNormals`；
   圆角盒只在圆角处分段（柱状图 `roundedBox`，一根柱 300 个三角形）。
2. **PBR 质感 + 影棚环境**：材质靠"反射一个有灯箱的房间"出质感，不靠一盏方向光。自建影棚场景（暗房间 + 几块发光 `PlaneGeometry` 灯箱：主光柔光箱、两侧灯条、顶灯），
   `PMREMGenerator.fromScene(…, { size: 64 })`，再用 MeshStandard/Physical（清漆 `clearcoat` 也行）在里面渲染一个球，烘成 matcap，场景里用 `MeshMatcapMaterial`（转台 `bake()`/`matcapMix()`）；
   不想走 GPU 烘焙就用 JS 直接算 matcap（爆炸图 `lit()`，用法同 MeshStandard）。只有屏幕占比小的主体（标志揭示的字）才直接上实时 MeshStandard + `scene.environment`。
3. **程序化细节贴图**：表面要有法线/粗糙度细节——压纹、滚花、拉丝、纸纹、颗粒、电路走线。画布画灰度高度图 → `normalFromHeight`（Sobel）→ `normalMap`；
   粗糙度遮罩混两张 matcap（抛光/拉丝）。准备阶段生成一次，128–256 的小图平铺 `repeat`，各向异性 ≤ 4。地形类把坡度、曲率、AO 烘进贴图，逐像素只取一次。
4. **接触阴影和 AO**：物体必须"落地"。径向渐变贴图平面（贴边很深、往外快速变淡）；顶点色压暗缝隙和贴地处（转台 `bakeAO`）；
   层间阴影用画布 `filter: blur` 画进下层贴图（爆炸图 `bakeShadow`，1/4 分辨率）。不用 shadowMap。
5. **轮廓光**：主体后侧一道冷色轮廓光，把边缘和背景分开（影棚里侧后的灯条，或着色器里 rim 方向 × 菲涅尔）。深色主体放深色背景时必须有，否则会糊进背景。
6. **文字锐利、按 480p 定尺寸**：屏幕文字走 HTML；贴图文字按屏幕像素生成（见上）。成片里主文字 ≥ 约 20 px 高，次要文字 ≥ 约 12 px；更小的字只当纹理看，不要指望能读。
   重要的字（标签主名、数值）加描边或底板，不要压在网格线和亮楼窗上。
7. **辉光要克制**：只让真正的高光发光（亮度 > 0.9 的软阈值），用 1/8 分辨率自制辉光（标志揭示 `bloom()`，`b / (1 + b)` 压缩防冲白）或加法混合的光晕精灵/光晕管（环绕推近）；
   大片粒子不要进辉光缓冲（会出一个发亮的方框、把画面冲白），粒子自己画光晕。不用 UnrealBloomPass。
8. **雾和空气透视**：远处先偏蓝变淡再融进天色，雾色和天空用同一个公式（在顶点里算）；户外加贴地高度雾。室内/产品用 CSS 背景柔光 + 暗角代替。
   推近时远景贴图做 mip 偏移模糊，就有景深感（环绕推近 `focusAt`）。
9. **不要默认平面材质**：不允许整件单色的默认 MeshStandard/Lambert、纯色背景、纯色地面。每个面至少有渐变（顶点色上亮下暗）、细节贴图或反射之一；
   地面用深色镜面台面（几何沿地面镜像 + MeshBasic + 往下指数衰减，模板缓冲或裁剪平面只画在台面上），背景用 CSS 径向渐变 + 暗角。
10. **色调**：ACES 色调映射，曝光 1.0–1.1；高光不要成片死白（成片里纯白像素不超过约 0.5%），暗部不要发灰发脏。

## 灯光与材质（软件渲染下的取舍）

- 整屏实时 `MeshStandardMaterial` 约是 `MeshBasicMaterial` 的 7 倍开销。大面积表面用：烘好的 matcap；把光照烘进贴图的 MeshBasic（地质）；
  或 MeshBasic + `onBeforeCompile` 在顶点里算光照/雾（环绕推近 `customize`）；自写 `ShaderMaterial` 末尾加 `#include <tonemapping_fragment>` 和 `#include <colorspace_fragment>`。
- matcap 不受 DirectionalLight 影响，布光全在影棚里；它的光照跟着镜头走。要光扫过物体，就在着色器里按世界坐标加一条移动亮带（爆炸图 `SWEEP`、标志揭示扫光）。
- 用 `onBeforeCompile` 改过的材质要设 `customProgramCacheKey`，代码不同的 key 必须不同，否则会共用错的着色器。
- 户外：天空自写渐变 + 太阳光晕（地形模板 `skyBase`），雾色和水面反射调用同一函数；`objects/Sky.js` 能用，但颜色很难和雾对上。
- 半透明：外壳 `depthWrite: false`，双面透明加 `forceSinglePass: true`；别用 `MeshPhysicalMaterial` 的 transmission（很慢）。

## 运镜（全部由 t 计算）

- `seg(t, a, b)` 把 t 映射成 0..1 进度，配 `easeInOut`/`easeOut`/`easeOutBack`；多个动作错峰就是给不同的 a、b。
- 环绕：`az = lerp(a0, a1, easeInOut(seg(t, 0, DURATION)))`，相机放在 `target + dist·(cosEl·sinAz, sinEl, cosEl·cosAz)` 后 `lookAt(target)`。
- 推近：距离、高度、注视点、`fov` 一起插值（改 fov 后 `updateProjectionMatrix()`）。转台、环绕全程缓入缓出；飞越匀速，不要缓停。
- 转台：转整数圈，两头慢中间快（转台模板 `spin`），开头和结尾正面朝镜头，背面一带而过。
- 飞越：`CatmullRomCurve3` 做路径，控制点高度取**前方一段**地形最高点加安全高度；朝向用切线的水平方向加固定俯角，不随地形抬头低头，转弯最多侧倾几度。
- 一个镜头一个主运镜，2–8 秒；动作在结束前 0.5–1 秒完成。

## 程序化建模

- 回转体（瓶、塔、杯）：`LatheGeometry(圆角轮廓点)`；平面轮廓加厚度（中框、徽标、图标、剖面）：`Shape` + `ExtrudeGeometry`（可挖洞、带倒角）；圆角盒 `RoundedBoxGeometry` 或自写。
- 大量重复物体（楼群、树、贴片元件、点位）：`InstancedMesh` + `setMatrixAt`/`setColorAt`，一次 draw call。同材质静态零件合并：`mergeGeometries([...])`。
- 地形：高度场先在 JS 里算成数组（带种子噪声的脊状/分形 + 冲沟），再烘出法线、坡度、曲率、山影、AO 贴图；网格分块 + 远处降细分，细节交给贴图（见地形模板）。
  先求噪声的实际范围再映射到固定高程，配色阈值才可控。
- 地质剖面：按"地层界面高程 + 褶皱/断层"判断每个点属于哪层，画成剖面贴图（地质模板 `sectionTexture`）。地表/侧壁做成半透明或淡出，就能"透视"地下的矿体和钻孔。
- 不规则体（矿体、岩石）：`IcosahedronGeometry` 沿法线按噪声位移；判断点是否在体内用同一个函数（地质模板 `gradeAt`），保证模型和数据一致。
- 逐步出现的线/管：`TubeGeometry` 建全长，`geometry.setDrawRange(0, n)` 按 t 控制画到哪；分段颜色写顶点色。

## 性能预算（实测：系统的无 GPU Chrome，WebGL2 由 SwiftShader 软件渲染，2 倍超采样）

单帧 = renderFrame + 截图；整段 = 含开页、编译、编码的总耗时；准备 = 测试脚本的首帧数字（含开页和编码启动，页面内 sceneReady 本身约 0.3–2.6 秒，其中约 0.9 秒是建 WebGL 上下文）。
4 核 = taskset 限制在 4 个 CPU 上，接近线上云服务器。测量时机器有其他负载，同一文件前后几次能差 ±30%。

| 模板（时长，可见三角形） | 4 核单帧 竖 / 横 | 4 核整段 竖 / 横 | 准备 |
|---|---|---|---|
| 产品转台（6s，2.2 万） | 117–147 / 115–130ms | 19–24 / 19–22s | 2.0–3.3s |
| 环绕推近（7s，7–8.5 万） | 100–102 / 97–99ms | 18 / 17s | 0.9–1.4s |
| 爆炸图（7s，1.65 万） | 80–101 / 80–113ms | 15–19 / 15–21s | 1.3–2.5s |
| 地形飞越（7s，7–8.4 万） | 133 / 75–156ms | 24 / 22s | 0.9–1.4s |
| 三维柱状图（6s，0.4 万） | 72–90 / 80–92ms | 11–15 / 12–14s | 0.4–1.6s |
| 标志揭示（5s，3.5 万，含辉光） | 76–154 / 118–224ms | 14–22 / 17–30s | 2.7–5.4s |
| 地质勘探（8s，3.3 万） | 128–141 / 115–125ms | 26–28 / 23–25s | 1.0–1.5s |

- **预算**：可见三角形 ≤ 15 万；4 核单帧 ≤ 150ms；整段 ≤ 镜头时长 × 5；准备 ≤ 3 秒。单帧硬上限 5 秒，超了整段失败；
  第 1–4 帧平均超过 170ms，系统会放弃 2 倍超采样、整段改用 1 倍重渲（边缘变粗，还白花了一遍时间）。
- 标志揭示（全屏辉光）和产品转台最贴近上限：标志揭示 16:9 在机器忙时测到过 224ms / 30s，超预算；在这两个模板上不要再加东西。
- **固定开销**：只清屏的空页面每帧也要约 50–80ms（截图、编码），所以留给场景本身的只有约 70–100ms。上表多数模板已接近上限：在模板上加东西要先减掉同样多的开销。
- **贵的东西**：
  - 每个全屏后期通道约 50ms（UnrealBloom + 多重采样渲染目标单帧就超预算）；实时 PBR 满屏、shadowMap；
  - 三角形（大约 1µs 一个；软件渲染下顶点数对耗时的影响常比像素数大）；大面积半透明；
  - 着色器里的 `if`（两边都执行）、`pow`、多余的 varying、各向异性 > 4、三线性过滤（大地面用 `LinearMipmapNearestFilter`）；
  - 盖在 WebGL 画布**上面**的全屏 CSS 半透明层，每帧截图合成多 5–40ms（放到画布下面的 body 背景里，或最后画一张乘法混合的全屏网格）。
- **准备阶段的坑**：PMREM 耗时和 size 的平方成正比（256 要 3–9 秒，用 64）；`compileAsync` 可能空等 5–10 秒（用 `renderer.compile` + 预热一帧）；
  画布 `ctx.filter = 'blur()'` 在贴图上传时才执行（大图可多出近 3 秒，只在小画布上用）；整屏 `getImageData` 回读要半秒以上（噪点用 128×128 小图平铺）。
- **超预算先砍**：细分段数和粒子数 → 半透明面积 → 贴图尺寸/各向异性 → 辉光。
- **并发**：所有 WebGL 页面共用浏览器的一个 SwiftShader GPU 进程，同时渲染几个三维镜头几乎不提速，每个都会成倍变慢（4 核上 4 个并发，单个镜头要 50–150 秒）。三维镜头尽量少而短。
- 抽帧检查：全黑多半是相机在物体内部、`lookAt` 错了或没有光源；大面积纯色多半是相机穿进了地形或模型；在成片尺寸下看文字能不能读、有没有出框和死白。

参考资料：本技能的组织方式参考了 [CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills)（MIT License），
内容按本系统“逐帧确定性渲染、无网络”的约束重写。
