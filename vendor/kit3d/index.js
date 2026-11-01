// Generic detail kit for procedurally built 3D objects: one import for everything.
// 程序化物体细节工具包：import * as kit from '/vendor/kit3d/index.js'
//   noise.js       种子化噪声 / seeded PRNG, Perlin, fbm, ridged, Worley (3D and tileable 2D)
//   textures.js    高度场 → 法线/粗糙度/色彩贴图、画布贴图、世界单位 UV / height fields → maps, canvas textures, world UVs
//   shader.js      物体空间补丁、三平面细节 / object-space material patches, triplanar detail
//   surface.js     置换、细分、曲率上色、表面细节贴图与配方 / displacement, subdivision, curvature tint, surface maps & recipes
//   hardsurface.js 圆角体、面板缝、螺丝、线缆、带子、沿曲线实例、网罩、百叶 / bevels, seams, bolts, cables, straps, grilles, vents
//   materials.js   材质预设 / metal, plastic, glass, fabric, foil, wood, ceramic, rubber
//   decals.js      标签/铭牌贴图与贴花网格 / labels, rating plates, decals
//   studio.js      影棚/暗环境、接触阴影、AO 斑、倒影地面、三角形统计、window.__three / lighting, shadows, ground, __three
export * from './noise.js';
export * from './textures.js';
export * from './shader.js';
export * from './surface.js';
export * from './hardsurface.js';
export * from './materials.js';
export * from './decals.js';
export * from './studio.js';
