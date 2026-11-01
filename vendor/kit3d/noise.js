// Seeded noise helpers for the procedural modelling kit. Everything here is deterministic: the same seed
// gives the same numbers on every machine, so a 3D shot renders identically frame after frame and run after run.
// 种子化噪声工具：同一个 seed 永远得到同样的结果（渲染可复现）。

/**
 * mulberry32 伪随机数发生器 / mulberry32 PRNG.
 * @param {number} seed 整数种子 / integer seed
 * @returns {() => number} 每次调用返回 [0,1) / returns a float in [0,1) per call
 */
export function mulberry32( seed ) {

	let a = seed | 0;
	return () => {

		a = ( a + 0x6d2b79f5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/**
 * 便捷随机数对象 / convenience random source.
 * rng.next() → [0,1); rng.range(a,b); rng.int(n) → 0..n-1; rng.normal() 标准正态; rng.sign();
 * rng.dir() → 单位球面上均匀分布的 [x,y,z] / uniform unit vector; rng.pick(array).
 * @param {number} seed
 */
export function makeRng( seed = 1 ) {

	const next = mulberry32( ( seed * 2654435761 ) ^ 0x9e3779b9 );
	const r = {
		next,
		range: ( a, b ) => a + ( b - a ) * next(),
		int: ( n ) => Math.floor( next() * n ),
		sign: () => ( next() < 0.5 ? - 1 : 1 ),
		normal: () => {

			const u = Math.max( 1e-9, next() ), v = next();
			return Math.sqrt( - 2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );

		},
		dir: () => {

			const z = next() * 2 - 1, a = next() * Math.PI * 2, s = Math.sqrt( 1 - z * z );
			return [ s * Math.cos( a ), s * Math.sin( a ), z ];

		},
		pick: ( arr ) => arr[ Math.floor( next() * arr.length ) ],
		/** 幂律分布（多小少大），用于坑点/颗粒/碎块尺寸 / power-law sample in [min,max]: many small, few large (pits, grains, chips) */
		power: ( min, max, alpha = 2 ) => {

			const u = next(), a1 = 1 - alpha;
			return Math.pow( ( Math.pow( max, a1 ) - Math.pow( min, a1 ) ) * u + Math.pow( min, a1 ), 1 / a1 );

		},
	};
	return r;

}

/** 整数哈希 → [0,1) / integer lattice hash to [0,1). */
export function hash3( x, y, z, seed = 0 ) {

	let h = Math.imul( x | 0, 374761393 ) ^ Math.imul( y | 0, 668265263 ) ^ Math.imul( z | 0, 2147483647 ) ^ Math.imul( seed | 0, 1274126177 );
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	h ^= h >>> 16;
	return ( h >>> 0 ) / 4294967296;

}

const GRAD3 = new Float32Array( [ 1, 1, 0, - 1, 1, 0, 1, - 1, 0, - 1, - 1, 0, 1, 0, 1, - 1, 0, 1, 1, 0, - 1, - 1, 0, - 1, 0, 1, 1, 0, - 1, 1, 0, 1, - 1, 0, - 1, - 1, 1, 1, 0, - 1, 1, 0, 0, - 1, 1, 0, - 1, - 1 ] );

function permutation( seed ) {

	const rand = mulberry32( seed ^ 0x5bd1e995 );
	const p = new Uint8Array( 256 );
	for ( let i = 0; i < 256; i ++ ) p[ i ] = i;
	for ( let i = 255; i > 0; i -- ) {

		const j = Math.floor( rand() * ( i + 1 ) );
		const t = p[ i ]; p[ i ] = p[ j ]; p[ j ] = t;

	}

	const perm = new Uint8Array( 512 );
	for ( let i = 0; i < 512; i ++ ) perm[ i ] = p[ i & 255 ];
	return perm;

}

const fade = ( t ) => t * t * t * ( t * ( t * 6 - 15 ) + 10 );

/**
 * 三维梯度噪声（改进 Perlin），输出约 [-1,1] / 3D gradient noise (improved Perlin), about [-1,1].
 * @param {number} seed
 * @returns {(x:number,y:number,z:number)=>number}
 */
export function makeNoise3( seed = 1 ) {

	const perm = permutation( seed );
	const g = ( h, x, y, z ) => {

		const i = ( h % 16 ) * 3;
		return GRAD3[ i ] * x + GRAD3[ i + 1 ] * y + GRAD3[ i + 2 ] * z;

	};

	return ( x, y, z ) => {

		const X = Math.floor( x ), Y = Math.floor( y ), Z = Math.floor( z );
		x -= X; y -= Y; z -= Z;
		const xi = X & 255, yi = Y & 255, zi = Z & 255;
		const u = fade( x ), v = fade( y ), w = fade( z );
		const A = perm[ xi ] + yi, AA = perm[ A ] + zi, AB = perm[ A + 1 ] + zi;
		const B = perm[ xi + 1 ] + yi, BA = perm[ B ] + zi, BB = perm[ B + 1 ] + zi;
		const l1 = g( perm[ AA ], x, y, z ) + u * ( g( perm[ BA ], x - 1, y, z ) - g( perm[ AA ], x, y, z ) );
		const l2 = g( perm[ AB ], x, y - 1, z ) + u * ( g( perm[ BB ], x - 1, y - 1, z ) - g( perm[ AB ], x, y - 1, z ) );
		const l3 = g( perm[ AA + 1 ], x, y, z - 1 ) + u * ( g( perm[ BA + 1 ], x - 1, y, z - 1 ) - g( perm[ AA + 1 ], x, y, z - 1 ) );
		const l4 = g( perm[ AB + 1 ], x, y - 1, z - 1 ) + u * ( g( perm[ BB + 1 ], x - 1, y - 1, z - 1 ) - g( perm[ AB + 1 ], x, y - 1, z - 1 ) );
		const m1 = l1 + v * ( l2 - l1 ), m2 = l3 + v * ( l4 - l3 );
		return ( m1 + w * ( m2 - m1 ) ) * 0.97;

	};

}

/**
 * 分形布朗运动 / fractal Brownian motion over a 3D noise.
 * @param {(x:number,y:number,z:number)=>number} noise makeNoise3(...) 的返回值
 * @param {{octaves?:number, lacunarity?:number, gain?:number}} [o]
 */
export function fbm3( noise, x, y, z, o = {} ) {

	const oct = o.octaves ?? 5, lac = o.lacunarity ?? 2.03, gain = o.gain ?? 0.5;
	let a = 1, f = 1, s = 0, n = 0;
	for ( let i = 0; i < oct; i ++ ) {

		s += a * noise( x * f + i * 17.1, y * f - i * 7.3, z * f + i * 3.7 );
		n += a; a *= gain; f *= lac;

	}

	return s / n;

}

/** 脊状噪声（山脊、褶皱），输出 [0,1] / ridged multifractal noise in [0,1]. */
export function ridged3( noise, x, y, z, o = {} ) {

	const oct = o.octaves ?? 4, lac = o.lacunarity ?? 2.1, gain = o.gain ?? 0.5;
	let a = 1, f = 1, s = 0, n = 0, prev = 1;
	for ( let i = 0; i < oct; i ++ ) {

		let v = 1 - Math.abs( noise( x * f + i * 11.3, y * f + i * 5.1, z * f - i * 9.7 ) );
		v *= v;
		s += a * v * prev; n += a; prev = v;
		a *= gain; f *= lac;

	}

	return s / n;

}

/**
 * 三维 Worley/Voronoi 噪声 / 3D cellular noise.
 * 返回函数写入同一个结果对象（避免分配）：{ f1, f2, id }，距离以格子为单位。
 * @param {number} seed
 * @returns {(x:number,y:number,z:number)=>{f1:number,f2:number,id:number}}
 */
export function makeWorley3( seed = 1 ) {

	const out = { f1: 0, f2: 0, id: 0 };
	return ( x, y, z ) => {

		const X = Math.floor( x ), Y = Math.floor( y ), Z = Math.floor( z );
		let f1 = 1e9, f2 = 1e9, id = 0;
		for ( let k = - 1; k <= 1; k ++ ) for ( let j = - 1; j <= 1; j ++ ) for ( let i = - 1; i <= 1; i ++ ) {

			const cx = X + i, cy = Y + j, cz = Z + k;
			const px = cx + hash3( cx, cy, cz, seed ) - x;
			const py = cy + hash3( cx, cy, cz, seed + 1 ) - y;
			const pz = cz + hash3( cx, cy, cz, seed + 2 ) - z;
			const d = px * px + py * py + pz * pz;
			if ( d < f1 ) {

				f2 = f1; f1 = d; id = hash3( cx, cy, cz, seed + 3 );

			} else if ( d < f2 ) f2 = d;

		}

		out.f1 = Math.sqrt( f1 ); out.f2 = Math.sqrt( f2 ); out.id = id;
		return out;

	};

}

/**
 * 可平铺的二维梯度噪声（周期 period，整数）/ tileable 2D gradient noise with an integer period.
 * 用于程序化贴图：贴图四边无缝衔接。
 * @param {number} seed
 * @returns {(x:number,y:number,px:number,py?:number)=>number} x,y 以格子为单位；px/py 为 x/y 方向周期
 */
export function makeNoise2Periodic( seed = 1 ) {

	const perm = permutation( seed );
	const grad = ( ix, iy, x, y ) => {

		const h = perm[ ( perm[ ix & 255 ] + iy ) & 511 ] & 7;
		const a = h * Math.PI / 4;
		return Math.cos( a ) * x + Math.sin( a ) * y;

	};

	return ( x, y, px, py = px ) => {

		const X = Math.floor( x ), Y = Math.floor( y );
		const fx = x - X, fy = y - Y;
		const x0 = ( ( X % px ) + px ) % px, y0 = ( ( Y % py ) + py ) % py;
		const x1 = ( x0 + 1 ) % px, y1 = ( y0 + 1 ) % py;
		const u = fade( fx ), v = fade( fy );
		const a = grad( x0, y0, fx, fy ), b = grad( x1, y0, fx - 1, fy );
		const c = grad( x0, y1, fx, fy - 1 ), d = grad( x1, y1, fx - 1, fy - 1 );
		return ( a + u * ( b - a ) + v * ( c + u * ( d - c ) - a - u * ( b - a ) ) ) * 1.4;

	};

}

/** 可平铺 fbm（u,v ∈ [0,1)，base 为最低频周期）/ tileable fbm over the unit square, base = lowest period. */
export function fbm2Periodic( noise2, u, v, base = 4, octaves = 5, gain = 0.5 ) {

	return fbm2PeriodicXY( noise2, u, v, base, base, octaves, gain );

}

/**
 * 各向异性可平铺 fbm：x、y 方向周期不同（拉长的纹理：木纹、树皮沟、拉丝）。
 * Anisotropic tileable fbm: separate integer periods along u and v (stretched features: grain, furrows, brushing).
 * @param {Function} noise2 makeNoise2Periodic(seed) 的返回值 / from makeNoise2Periodic
 * @param {number} u ∈ [0,1) @param {number} v ∈ [0,1)
 * @param {number} px u 方向最低频周期（整数）/ lowest period along u (integer)
 * @param {number} py v 方向最低频周期（整数）/ lowest period along v (integer)
 * @param {number} [octaves=5] @param {number} [gain=0.5]
 * @param {boolean} [ridged=false] 脊状（1-|n|)² / ridged octaves
 * @returns {number} fbm 约 [-1,1]；ridged 时 [0,1] / about [-1,1], or [0,1] when ridged
 */
export function fbm2PeriodicXY( noise2, u, v, px, py, octaves = 5, gain = 0.5, ridged = false ) {

	let a = 1, s = 0, n = 0;
	for ( let i = 0; i < octaves; i ++ ) {

		let x = noise2( u * px + i * 0.37, v * py + i * 0.61, px, py );
		if ( ridged ) {

			x = 1 - Math.abs( x ); x *= x;

		}

		s += a * x;
		n += a; a *= gain; px *= 2; py *= 2;

	}

	return s / n;

}

/**
 * 可平铺二维 Worley（周期 period 个格子；py 可另设 v 方向周期）/ tileable 2D cellular noise (optional separate v period).
 * f1/f2 为最近/次近特征点距离（格子单位），id/id2 为两格的随机值 [0,1)，(gx,gy) 为最近特征点到像素的方向。
 * f1/f2: nearest / second-nearest feature distance (cell units); id/id2: random value of those cells; (gx,gy): offset to the nearest feature.
 * @returns {(u:number,v:number,period:number,py?:number)=>{f1:number,f2:number,id:number,id2:number,gx:number,gy:number}} u,v ∈ [0,1)
 */
export function makeWorley2Periodic( seed = 1 ) {

	const out = { f1: 0, f2: 0, id: 0, id2: 0, gx: 0, gy: 0 };
	return ( u, v, period, periodY = period ) => {

		const x = u * period, y = v * periodY;
		const X = Math.floor( x ), Y = Math.floor( y );
		let f1 = 1e9, f2 = 1e9, id = 0, id2 = 0, gx = 0, gy = 0;
		for ( let j = - 1; j <= 1; j ++ ) for ( let i = - 1; i <= 1; i ++ ) {

			const cx = X + i, cy = Y + j;
			const wx = ( ( cx % period ) + period ) % period, wy = ( ( cy % periodY ) + periodY ) % periodY;
			const px = cx + hash3( wx, wy, 0, seed ) - x, py = cy + hash3( wx, wy, 1, seed ) - y;
			const d = px * px + py * py;
			const h = hash3( wx, wy, 2, seed );
			if ( d < f1 ) {

				f2 = f1; id2 = id; f1 = d; id = h; gx = px; gy = py;

			} else if ( d < f2 ) {

				f2 = d; id2 = h;

			}

		}

		out.f1 = Math.sqrt( f1 ); out.f2 = Math.sqrt( f2 ); out.id = id; out.id2 = id2; out.gx = gx; out.gy = gy;
		return out;

	};

}

/** 限制到 [a,b] / clamp. */
export const clamp = ( x, a = 0, b = 1 ) => ( x < a ? a : x > b ? b : x );

/** 线性插值 / linear interpolation. */
export const lerp = ( a, b, t ) => a + ( b - a ) * t;

export const smoothstep = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

/** 平滑最小/最大（k 为过渡宽度）/ polynomial smooth min / max. */
export const smin = ( a, b, k ) => {

	const h = Math.min( 1, Math.max( 0, 0.5 + 0.5 * ( b - a ) / k ) );
	return b + ( a - b ) * h - k * h * ( 1 - h );

};
export const smax = ( a, b, k ) => - smin( - a, - b, k );
