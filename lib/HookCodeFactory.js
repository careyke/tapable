/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

/**
 * 这个类的作用是在于动态组装 发布函数
 * 发布函数执行之后会依次执行订阅时注册的回调函数
 * 
 * ？？？ 为什么不每种类型定义一个发布函数呢？
 * 动态生成函数的代码难以理解！！！
 * 这里作者将整个任务执行流程理解到了极致，打破了 函数作为最小复用模块 这一常规做法，将语句作为最小复用模块
 * 整个发布流程可以分成三个部分：
 * 1. 以何种方式触发：不同的触发方式返回值不同。这部分逻辑由 create 函数来完成
 * 2. 以何种方式执行：不同类型的订阅者对应的回调函数不同，执行的方式也不同。 这部分逻辑由 callTap 方法来完成
 * 3. 以何种方式组织：多个订阅者是以何种方式来执行。 这部分逻辑由 callTapsSeries callTapsLooping callTapsParallel 这三个方法来实现。
 * 		分别代表：串行 串行循环 并行 三种组织方式
 */

class HookCodeFactory {
	constructor(config) {
		this.config = config;
		/**
		 * 调用compile方法时创建的参数
		 * 数据结构：
		 * {
		 * 	type: 'sync' | 'async' | 'promise' 表示hook的类型
		 * 	taps: [] 当前hook订阅者集合
		 * 	interceptors: [] 当前hook的拦截器
		 * 	args: string[] 当前hook规定的回调函数的形参
		 * }
		 */
		this.options = undefined;
		// options.args的副本
		this._args = undefined;
	}

	create(options) {
		this.init(options);
		let fn;
		// 根据不同的触发的方式有不同的处理逻辑，会生成不同的发布函数
		switch (this.options.type) {
			case "sync":
				// 同步的方式处理所有订阅者
				fn = new Function(
					this.args(),
					'"use strict";\n' +
						this.header() +
						this.contentWithInterceptors({
							onError: err => `throw ${err};\n`,
							onResult: result => `return ${result};\n`,
							resultReturns: true,
							onDone: () => "",
							rethrowIfPossible: true
						})
				);
				break;
			case "async":
				// 回调函数的方式处理异步调用
				// 发布时需要传入回调函数，在整个发布过程执行完成会触发回调函数
				fn = new Function(
					this.args({
						after: "_callback"
					}),
					'"use strict";\n' +
						this.header() +
						this.contentWithInterceptors({
							onError: err => `_callback(${err});\n`,
							onResult: result => `_callback(null, ${result});\n`,
							onDone: () => "_callback();\n"
						})
				);
				break;
			case "promise":
				// promise的方式处理异步调用
				// 发布函数返回一个promise，发布过程完成之后会改变promise的状态
				let errorHelperUsed = false;
				const content = this.contentWithInterceptors({
					onError: err => {
						errorHelperUsed = true;
						return `_error(${err});\n`;
					},
					onResult: result => `_resolve(${result});\n`,
					onDone: () => "_resolve();\n"
				});
				let code = "";
				code += '"use strict";\n';
				code += this.header();
				code += "return new Promise((function(_resolve, _reject) {\n";
				if (errorHelperUsed) {
					code += "var _sync = true;\n";
					code += "function _error(_err) {\n";
					code += "if(_sync)\n";
					code +=
						"_resolve(Promise.resolve().then((function() { throw _err; })));\n";
					code += "else\n";
					code += "_reject(_err);\n";
					code += "};\n";
				}
				code += content;
				if (errorHelperUsed) {
					code += "_sync = false;\n";
				}
				code += "}));\n";
				fn = new Function(this.args(), code);
				break;
		}
		this.deinit();
		return fn;
	}

	setup(instance, options) {
		instance._x = options.taps.map(t => t.fn);
	}

	/**
	 * @param {{ type: "sync" | "promise" | "async", taps: Array<Tap>, interceptors: Array<Interceptor> }} options
	 */
	init(options) {
		this.options = options;
		this._args = options.args.slice();
	}

	deinit() {
		this.options = undefined;
		this._args = undefined;
	}

	/**
	 * 生成函数体逻辑部分
	 * 每个不同类型的hook会对应不同的逻辑实现
	 * 
	 * 这里有一个点比较巧妙：因为不同类型hook之间最大的区别是在于 多个订阅者之间的关联关系不同，也就是多个回调函数之间的关系不同，
	 * 所以动态发布函数的逻辑就是需要按照某种关联关系来调用订阅者的回调函数。
	 * 在生成函数的时候，是 以每个订阅者回调函数的执行 作为一个基本单元来处理其中的关系，从而实现整个逻辑
	 * 
	 * options数据结构：
	 * {
	 * 	onError: 当前回调执行报错时，处理错误的代码文本，中断发布函数逻辑
	 * 	onDone: 当前回调执行完成之后 需要执行的代码文本
	 * 	onResult: 当前回调执行完成之后 需要执行的和返回值相关的代码文本
	 * 	resultReturns: boolean 是否有返回语句
	 * 	rethrowIfPossible: boolean 是否在捕获错误之后 处理相关逻辑 然后继续抛出错误
	 * }
	 * 
	 * 通过包装onDone和onResult的方式来实现回调函数之间的关系，从而实现整个发布函数的逻辑
	 * @param {*} options 
	 * @returns 
	 */
	contentWithInterceptors(options) {
		if (this.options.interceptors.length > 0) {
			const onError = options.onError;
			const onResult = options.onResult;
			const onDone = options.onDone;
			let code = "";
			for (let i = 0; i < this.options.interceptors.length; i++) {
				const interceptor = this.options.interceptors[i];
				if (interceptor.call) {
					// register.call 在触发之前拦截
					code += `${this.getInterceptor(i)}.call(${this.args({
						before: interceptor.context ? "_context" : undefined
					})});\n`;
				}
			}
			code += this.content(
				Object.assign(options, {
					onError:
						onError &&
						(err => {
							let code = "";
							for (let i = 0; i < this.options.interceptors.length; i++) {
								const interceptor = this.options.interceptors[i];
								if (interceptor.error) {
									// register.error 报错拦截
									code += `${this.getInterceptor(i)}.error(${err});\n`;
								}
							}
							code += onError(err);
							return code;
						}),
					onResult:
						onResult &&
						(result => {
							let code = "";
							for (let i = 0; i < this.options.interceptors.length; i++) {
								const interceptor = this.options.interceptors[i];
								if (interceptor.result) {
									// register 返回值之前拦截
									code += `${this.getInterceptor(i)}.result(${result});\n`;
								}
							}
							code += onResult(result);
							return code;
						}),
					onDone:
						onDone &&
						(() => {
							let code = "";
							for (let i = 0; i < this.options.interceptors.length; i++) {
								const interceptor = this.options.interceptors[i];
								if (interceptor.done) {
									// register.done 流程结束之前拦截
									code += `${this.getInterceptor(i)}.done();\n`;
								}
							}
							code += onDone();
							return code;
						})
				})
			);
			return code;
		} else {
			return this.content(options);
		}
	}

	/**
	 * 生成函数体头部
	 * 生成的函数最终是以对象属性的方式调用
	 * this指向当前hook实例
	 * @returns 
	 */
	header() {
		let code = "";
		if (this.needContext()) {
			// deprecated
			code += "var _context = {};\n";
		} else {
			code += "var _context;\n";
		}
		code += "var _x = this._x;\n";
		if (this.options.interceptors.length > 0) {
			code += "var _taps = this.taps;\n";
			code += "var _interceptors = this.interceptors;\n";
		}
		return code;
	}

	needContext() {
		for (const tap of this.options.taps) if (tap.context) return true;
		return false;
	}

	/**
	 * 处理单个回调函数的执行逻辑
	 * @param {*} tapIndex 
	 * @param {*} param1 
	 * @returns 
	 */
	callTap(tapIndex, { onError, onResult, onDone, rethrowIfPossible }) {
		let code = "";
		let hasTapCached = false;
		for (let i = 0; i < this.options.interceptors.length; i++) {
			const interceptor = this.options.interceptors[i];
			if (interceptor.tap) {
				// 订阅者回调函数执行之前拦截
				if (!hasTapCached) {
					code += `var _tap${tapIndex} = ${this.getTap(tapIndex)};\n`;
					hasTapCached = true;
				}
				code += `${this.getInterceptor(i)}.tap(${
					interceptor.context ? "_context, " : ""
				}_tap${tapIndex});\n`;
			}
		}
		code += `var _fn${tapIndex} = ${this.getTapFn(tapIndex)};\n`;
		const tap = this.options.taps[tapIndex];
		// 订阅者类型的不同生成不同的函数
		switch (tap.type) {
			case "sync":
				if (!rethrowIfPossible) {
					// 添加try/catch捕获错误
					code += `var _hasError${tapIndex} = false;\n`;
					code += "try {\n";
				}
				// 执行回调函数
				if (onResult) {
					code += `var _result${tapIndex} = _fn${tapIndex}(${this.args({
						before: tap.context ? "_context" : undefined
					})});\n`;
				} else {
					code += `_fn${tapIndex}(${this.args({
						before: tap.context ? "_context" : undefined
					})});\n`;
				}
				if (!rethrowIfPossible) {
					code += "} catch(_err) {\n";
					code += `_hasError${tapIndex} = true;\n`;
					code += onError("_err"); // 报错
					code += "}\n";
					code += `if(!_hasError${tapIndex}) {\n`;
				}
				// 处理返回值
				if (onResult) {
					code += onResult(`_result${tapIndex}`);
				}
				// 处理关系下游的回调函数
				if (onDone) {
					code += onDone();
				}
				if (!rethrowIfPossible) {
					code += "}\n";
				}
				break;
			case "async":
				let cbCode = "";
				// 创建回调函数，当前任务完成之后的回调，可以用来继续执行下一个任务
				if (onResult)
					cbCode += `(function(_err${tapIndex}, _result${tapIndex}) {\n`;
				else cbCode += `(function(_err${tapIndex}) {\n`;
				cbCode += `if(_err${tapIndex}) {\n`;
				cbCode += onError(`_err${tapIndex}`);
				cbCode += "} else {\n";
				if (onResult) {
					cbCode += onResult(`_result${tapIndex}`);
				}
				if (onDone) {
					cbCode += onDone();
				}
				cbCode += "}\n";
				cbCode += "})";
				// 异步逻辑需要通过回调函数来建立关系
				code += `_fn${tapIndex}(${this.args({
					before: tap.context ? "_context" : undefined,
					after: cbCode
				})});\n`;
				break;
			case "promise":
				code += `var _hasResult${tapIndex} = false;\n`;
				code += `var _promise${tapIndex} = _fn${tapIndex}(${this.args({
					before: tap.context ? "_context" : undefined
				})});\n`;
				code += `if (!_promise${tapIndex} || !_promise${tapIndex}.then)\n`;
				code += `  throw new Error('Tap function (tapPromise) did not return promise (returned ' + _promise${tapIndex} + ')');\n`;
				// onFulfilled
				code += `_promise${tapIndex}.then((function(_result${tapIndex}) {\n`;
				code += `_hasResult${tapIndex} = true;\n`;
				if (onResult) {
					code += onResult(`_result${tapIndex}`);
				}
				if (onDone) {
					code += onDone();
				}
				// onRejected
				code += `}), function(_err${tapIndex}) {\n`;
				code += `if(_hasResult${tapIndex}) throw _err${tapIndex};\n`;
				code += onError(`_err${tapIndex}`);
				code += "});\n";
				break;
		}
		return code;
	}

	/**
	 * 串行执行所有回调函数
	 * @param {*} param0 
	 * @returns 
	 */
	callTapsSeries({
		onError,
		onResult,
		resultReturns,
		onDone,
		doneReturns,
		rethrowIfPossible
	}) {
		if (this.options.taps.length === 0) return onDone();
		const firstAsync = this.options.taps.findIndex(t => t.type !== "sync");
		const somethingReturns = resultReturns || doneReturns;
		let code = "";
		let current = onDone;
		let unrollCounter = 0;
		// 倒序遍历
		for (let j = this.options.taps.length - 1; j >= 0; j--) {
			const i = j;
			const unroll =
				current !== onDone &&
				(this.options.taps[i].type !== "sync" || unrollCounter++ > 20);
			if (unroll) {
				// 将异步的回调函数执行代码封装成单独的函数，
				// 防止回调地狱
				unrollCounter = 0;
				code += `function _next${i}() {\n`;
				code += current();
				code += `}\n`;
				current = () => `${somethingReturns ? "return " : ""}_next${i}();\n`;
			}
			const done = current;
			const doneBreak = skipDone => {
				if (skipDone) return "";
				return onDone();
			};
			const content = this.callTap(i, {
				onError: error => onError(i, error, done, doneBreak),
				onResult:
					onResult &&
					(result => {
						return onResult(i, result, done, doneBreak);
					}),
				onDone: !onResult && done,
				rethrowIfPossible:
					rethrowIfPossible && (firstAsync < 0 || i < firstAsync)
			});
			current = () => content;
		}
		code += current();
		return code;
	}

	/**
	 * 串行循环执行
	 * @param {*} param0 
	 * @returns 
	 */
	callTapsLooping({ onError, onDone, rethrowIfPossible }) {
		if (this.options.taps.length === 0) return onDone();
		const syncOnly = this.options.taps.every(t => t.type === "sync");
		let code = "";
		if (!syncOnly) {
			code += "var _looper = (function() {\n";
			code += "var _loopAsync = false;\n";
		}
		code += "var _loop;\n";
		code += "do {\n";
		code += "_loop = false;\n";
		for (let i = 0; i < this.options.interceptors.length; i++) {
			const interceptor = this.options.interceptors[i];
			if (interceptor.loop) {
				// 每次循环之前拦截
				code += `${this.getInterceptor(i)}.loop(${this.args({
					before: interceptor.context ? "_context" : undefined
				})});\n`;
			}
		}
		code += this.callTapsSeries({
			onError,
			onResult: (i, result, next, doneBreak) => {
				let code = "";
				code += `if(${result} !== undefined) {\n`;
				code += "_loop = true;\n";
				if (!syncOnly) code += "if(_loopAsync) _looper();\n"; // 异步回调函数的存在，会先跳出循环，所以需要提供一个机制来重新开启循环
				code += doneBreak(true);
				code += `} else {\n`;
				code += next();
				code += `}\n`;
				return code;
			},
			onDone:
				onDone &&
				(() => {
					let code = "";
					code += "if(!_loop) {\n";
					code += onDone();
					code += "}\n";
					return code;
				}),
			rethrowIfPossible: rethrowIfPossible && syncOnly
		});
		code += "} while(_loop);\n";
		if (!syncOnly) {
			code += "_loopAsync = true;\n";
			code += "});\n";
			code += "_looper();\n";
		}
		return code;
	}

	/**
	 * 并行执行回调函数
	 * @param {*} param0 
	 * @returns 
	 */
	callTapsParallel({
		onError,
		onResult,
		onDone,
		rethrowIfPossible,
		onTap = (i, run) => run()
	}) {
		if (this.options.taps.length <= 1) {
			return this.callTapsSeries({
				onError,
				onResult,
				onDone,
				rethrowIfPossible
			});
		}
		let code = "";
		code += "do {\n";
		code += `var _counter = ${this.options.taps.length};\n`;
		if (onDone) {
			code += "var _done = (function() {\n";
			code += onDone();
			code += "});\n";
		}
		// 正序遍历
		for (let i = 0; i < this.options.taps.length; i++) {
			const done = () => {
				if (onDone) return "if(--_counter === 0) _done();\n"; // 最后一个回调函数执行完成之后就调用done函数，表示发布流程完成
				else return "--_counter;";
			};
			const doneBreak = skipDone => {
				if (skipDone || !onDone) return "_counter = 0;\n";
				else return "_counter = 0;\n_done();\n";
			};
			code += "if(_counter <= 0) break;\n";
			code += onTap(
				i,
				() =>
					this.callTap(i, {
						onError: error => {
							let code = "";
							code += "if(_counter > 0) {\n";
							code += onError(i, error, done, doneBreak);
							code += "}\n";
							return code;
						},
						onResult:
							onResult &&
							(result => {
								let code = "";
								code += "if(_counter > 0) {\n";
								code += onResult(i, result, done, doneBreak);
								code += "}\n";
								return code;
							}),
						onDone:
							!onResult &&
							(() => {
								return done();
							}),
						rethrowIfPossible
					}),
				done,
				doneBreak
			);
		}
		code += "} while(false);\n";
		return code;
	}

	/**
	 * 处理动态生成的发布函数的形参
	 * 生成形参字符串 'arg1, arg2, ..., argN'
	 * @param {*} param0 
	 * @returns 
	 */
	args({ before, after } = {}) {
		let allArgs = this._args;
		if (before) allArgs = [before].concat(allArgs);
		if (after) allArgs = allArgs.concat(after);
		if (allArgs.length === 0) {
			return "";
		} else {
			return allArgs.join(", ");
		}
	}

	getTapFn(idx) {
		return `_x[${idx}]`;
	}

	getTap(idx) {
		return `_taps[${idx}]`;
	}

	getInterceptor(idx) {
		return `_interceptors[${idx}]`;
	}
}

module.exports = HookCodeFactory;
