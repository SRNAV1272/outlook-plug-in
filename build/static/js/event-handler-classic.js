// =============================================================================
// CardByte Signature Manager — event-handler-classic.js (bundle, classic-v6.0.0)
// =============================================================================
//
// Single-file bundle for Classic Outlook on Windows (JSRuntime override).
// Concatenation of:
//   1. CryptoJS 4.2.0, trimmed to AES-CBC/PKCS7/Base64 (crypto.subtle is not
//      available in the classic JSRuntime)
//   2. html-content-signature v2 (send-time tamper verification)
//   3. The classic handler
//
// Build: cat cryptojs.trimmed.js hcs.js classic-handler.js > event-handler-classic.js
// =============================================================================

// CryptoJS 4.2.0 (MIT, https://github.com/brix/crypto-js) — TRIMMED BUNDLE.
// Only core, enc-base64, md5, evpkdf, cipher-core (CBC + PKCS7) and aes are
// included; that is everything encryptEmail/decryptResponse use. Built with
// esbuild (es2015). The global is assigned explicitly on every known root
// name because Classic Outlook's JSRuntime is not a clean browser/node global.
; (function (root, factory) {
    var C = factory();
    try { root.CryptoJS = C; } catch (_) { }
    try { if (typeof globalThis !== "undefined") globalThis.CryptoJS = C; } catch (_) { }
    try { if (typeof self !== "undefined") self.CryptoJS = C; } catch (_) { }
    try { if (typeof window !== "undefined") window.CryptoJS = C; } catch (_) { }
}((typeof self !== "undefined" && self) || (typeof window !== "undefined" && window) ||
    (typeof globalThis !== "undefined" && globalThis) || this, function () {
        return (() => {
            var __getOwnPropNames = Object.getOwnPropertyNames;
            var __require = /* @__PURE__ */ ((x) => typeof require != "undefined" ? require : typeof Proxy != "undefined" ? new Proxy(x, {
                get: (a, b) => (typeof require != "undefined" ? require : a)[b]
            }) : x)(function (x) {
                if (typeof require != "undefined") return require.apply(this, arguments);
                throw Error('Dynamic require of "' + x + '" is not supported');
            });
            var __commonJS = (cb, mod) => function () {
                return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
            };

            // node_modules/crypto-js/core.js
            var require_core = __commonJS({
                "node_modules/crypto-js/core.js"(exports, module) {
                    (function (root, factory) {
                        typeof exports == "object" ? module.exports = exports = factory() : typeof define == "function" && define.amd ? define([], factory) : root.CryptoJS = factory();
                    })(exports, function () {
                        var CryptoJS = CryptoJS || function (Math2, undefined) {
                            var crypto;
                            if (typeof window != "undefined" && window.crypto && (crypto = window.crypto), typeof self != "undefined" && self.crypto && (crypto = self.crypto), typeof globalThis != "undefined" && globalThis.crypto && (crypto = globalThis.crypto), !crypto && typeof window != "undefined" && window.msCrypto && (crypto = window.msCrypto), !crypto && typeof global != "undefined" && global.crypto && (crypto = global.crypto), !crypto && typeof __require == "function")
                                try {
                                    crypto = __require("crypto");
                                } catch (err) {
                                }
                            var cryptoSecureRandomInt = function () {
                                if (crypto) {
                                    if (typeof crypto.getRandomValues == "function")
                                        try {
                                            return crypto.getRandomValues(new Uint32Array(1))[0];
                                        } catch (err) {
                                        }
                                    if (typeof crypto.randomBytes == "function")
                                        try {
                                            return crypto.randomBytes(4).readInt32LE();
                                        } catch (err) {
                                        }
                                }
                                throw new Error("Native crypto module could not be used to get secure random number.");
                            }, create = Object.create || /* @__PURE__ */ function () {
                                function F() {
                                }
                                return function (obj) {
                                    var subtype;
                                    return F.prototype = obj, subtype = new F(), F.prototype = null, subtype;
                                };
                            }(), C = {}, C_lib = C.lib = {}, Base = C_lib.Base = /* @__PURE__ */ function () {
                                return {
                                    /**
                                     * Creates a new object that inherits from this object.
                                     *
                                     * @param {Object} overrides Properties to copy into the new object.
                                     *
                                     * @return {Object} The new object.
                                     *
                                     * @static
                                     *
                                     * @example
                                     *
                                     *     var MyType = CryptoJS.lib.Base.extend({
                                     *         field: 'value',
                                     *
                                     *         method: function () {
                                     *         }
                                     *     });
                                     */
                                    extend: function (overrides) {
                                        var subtype = create(this);
                                        return overrides && subtype.mixIn(overrides), (!subtype.hasOwnProperty("init") || this.init === subtype.init) && (subtype.init = function () {
                                            subtype.$super.init.apply(this, arguments);
                                        }), subtype.init.prototype = subtype, subtype.$super = this, subtype;
                                    },
                                    /**
                                     * Extends this object and runs the init method.
                                     * Arguments to create() will be passed to init().
                                     *
                                     * @return {Object} The new object.
                                     *
                                     * @static
                                     *
                                     * @example
                                     *
                                     *     var instance = MyType.create();
                                     */
                                    create: function () {
                                        var instance = this.extend();
                                        return instance.init.apply(instance, arguments), instance;
                                    },
                                    /**
                                     * Initializes a newly created object.
                                     * Override this method to add some logic when your objects are created.
                                     *
                                     * @example
                                     *
                                     *     var MyType = CryptoJS.lib.Base.extend({
                                     *         init: function () {
                                     *             // ...
                                     *         }
                                     *     });
                                     */
                                    init: function () {
                                    },
                                    /**
                                     * Copies properties into this object.
                                     *
                                     * @param {Object} properties The properties to mix in.
                                     *
                                     * @example
                                     *
                                     *     MyType.mixIn({
                                     *         field: 'value'
                                     *     });
                                     */
                                    mixIn: function (properties) {
                                        for (var propertyName in properties)
                                            properties.hasOwnProperty(propertyName) && (this[propertyName] = properties[propertyName]);
                                        properties.hasOwnProperty("toString") && (this.toString = properties.toString);
                                    },
                                    /**
                                     * Creates a copy of this object.
                                     *
                                     * @return {Object} The clone.
                                     *
                                     * @example
                                     *
                                     *     var clone = instance.clone();
                                     */
                                    clone: function () {
                                        return this.init.prototype.extend(this);
                                    }
                                };
                            }(), WordArray = C_lib.WordArray = Base.extend({
                                /**
                                 * Initializes a newly created word array.
                                 *
                                 * @param {Array} words (Optional) An array of 32-bit words.
                                 * @param {number} sigBytes (Optional) The number of significant bytes in the words.
                                 *
                                 * @example
                                 *
                                 *     var wordArray = CryptoJS.lib.WordArray.create();
                                 *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607]);
                                 *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607], 6);
                                 */
                                init: function (words, sigBytes) {
                                    words = this.words = words || [], sigBytes != undefined ? this.sigBytes = sigBytes : this.sigBytes = words.length * 4;
                                },
                                /**
                                 * Converts this word array to a string.
                                 *
                                 * @param {Encoder} encoder (Optional) The encoding strategy to use. Default: CryptoJS.enc.Hex
                                 *
                                 * @return {string} The stringified word array.
                                 *
                                 * @example
                                 *
                                 *     var string = wordArray + '';
                                 *     var string = wordArray.toString();
                                 *     var string = wordArray.toString(CryptoJS.enc.Utf8);
                                 */
                                toString: function (encoder) {
                                    return (encoder || Hex).stringify(this);
                                },
                                /**
                                 * Concatenates a word array to this word array.
                                 *
                                 * @param {WordArray} wordArray The word array to append.
                                 *
                                 * @return {WordArray} This word array.
                                 *
                                 * @example
                                 *
                                 *     wordArray1.concat(wordArray2);
                                 */
                                concat: function (wordArray) {
                                    var thisWords = this.words, thatWords = wordArray.words, thisSigBytes = this.sigBytes, thatSigBytes = wordArray.sigBytes;
                                    if (this.clamp(), thisSigBytes % 4)
                                        for (var i = 0; i < thatSigBytes; i++) {
                                            var thatByte = thatWords[i >>> 2] >>> 24 - i % 4 * 8 & 255;
                                            thisWords[thisSigBytes + i >>> 2] |= thatByte << 24 - (thisSigBytes + i) % 4 * 8;
                                        }
                                    else
                                        for (var j = 0; j < thatSigBytes; j += 4)
                                            thisWords[thisSigBytes + j >>> 2] = thatWords[j >>> 2];
                                    return this.sigBytes += thatSigBytes, this;
                                },
                                /**
                                 * Removes insignificant bits.
                                 *
                                 * @example
                                 *
                                 *     wordArray.clamp();
                                 */
                                clamp: function () {
                                    var words = this.words, sigBytes = this.sigBytes;
                                    words[sigBytes >>> 2] &= 4294967295 << 32 - sigBytes % 4 * 8, words.length = Math2.ceil(sigBytes / 4);
                                },
                                /**
                                 * Creates a copy of this word array.
                                 *
                                 * @return {WordArray} The clone.
                                 *
                                 * @example
                                 *
                                 *     var clone = wordArray.clone();
                                 */
                                clone: function () {
                                    var clone = Base.clone.call(this);
                                    return clone.words = this.words.slice(0), clone;
                                },
                                /**
                                 * Creates a word array filled with random bytes.
                                 *
                                 * @param {number} nBytes The number of random bytes to generate.
                                 *
                                 * @return {WordArray} The random word array.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var wordArray = CryptoJS.lib.WordArray.random(16);
                                 */
                                random: function (nBytes) {
                                    for (var words = [], i = 0; i < nBytes; i += 4)
                                        words.push(cryptoSecureRandomInt());
                                    return new WordArray.init(words, nBytes);
                                }
                            }), C_enc = C.enc = {}, Hex = C_enc.Hex = {
                                /**
                                 * Converts a word array to a hex string.
                                 *
                                 * @param {WordArray} wordArray The word array.
                                 *
                                 * @return {string} The hex string.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var hexString = CryptoJS.enc.Hex.stringify(wordArray);
                                 */
                                stringify: function (wordArray) {
                                    for (var words = wordArray.words, sigBytes = wordArray.sigBytes, hexChars = [], i = 0; i < sigBytes; i++) {
                                        var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
                                        hexChars.push((bite >>> 4).toString(16)), hexChars.push((bite & 15).toString(16));
                                    }
                                    return hexChars.join("");
                                },
                                /**
                                 * Converts a hex string to a word array.
                                 *
                                 * @param {string} hexStr The hex string.
                                 *
                                 * @return {WordArray} The word array.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var wordArray = CryptoJS.enc.Hex.parse(hexString);
                                 */
                                parse: function (hexStr) {
                                    for (var hexStrLength = hexStr.length, words = [], i = 0; i < hexStrLength; i += 2)
                                        words[i >>> 3] |= parseInt(hexStr.substr(i, 2), 16) << 24 - i % 8 * 4;
                                    return new WordArray.init(words, hexStrLength / 2);
                                }
                            }, Latin1 = C_enc.Latin1 = {
                                /**
                                 * Converts a word array to a Latin1 string.
                                 *
                                 * @param {WordArray} wordArray The word array.
                                 *
                                 * @return {string} The Latin1 string.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var latin1String = CryptoJS.enc.Latin1.stringify(wordArray);
                                 */
                                stringify: function (wordArray) {
                                    for (var words = wordArray.words, sigBytes = wordArray.sigBytes, latin1Chars = [], i = 0; i < sigBytes; i++) {
                                        var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
                                        latin1Chars.push(String.fromCharCode(bite));
                                    }
                                    return latin1Chars.join("");
                                },
                                /**
                                 * Converts a Latin1 string to a word array.
                                 *
                                 * @param {string} latin1Str The Latin1 string.
                                 *
                                 * @return {WordArray} The word array.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var wordArray = CryptoJS.enc.Latin1.parse(latin1String);
                                 */
                                parse: function (latin1Str) {
                                    for (var latin1StrLength = latin1Str.length, words = [], i = 0; i < latin1StrLength; i++)
                                        words[i >>> 2] |= (latin1Str.charCodeAt(i) & 255) << 24 - i % 4 * 8;
                                    return new WordArray.init(words, latin1StrLength);
                                }
                            }, Utf8 = C_enc.Utf8 = {
                                /**
                                 * Converts a word array to a UTF-8 string.
                                 *
                                 * @param {WordArray} wordArray The word array.
                                 *
                                 * @return {string} The UTF-8 string.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var utf8String = CryptoJS.enc.Utf8.stringify(wordArray);
                                 */
                                stringify: function (wordArray) {
                                    try {
                                        return decodeURIComponent(escape(Latin1.stringify(wordArray)));
                                    } catch (e) {
                                        throw new Error("Malformed UTF-8 data");
                                    }
                                },
                                /**
                                 * Converts a UTF-8 string to a word array.
                                 *
                                 * @param {string} utf8Str The UTF-8 string.
                                 *
                                 * @return {WordArray} The word array.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var wordArray = CryptoJS.enc.Utf8.parse(utf8String);
                                 */
                                parse: function (utf8Str) {
                                    return Latin1.parse(unescape(encodeURIComponent(utf8Str)));
                                }
                            }, BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm = Base.extend({
                                /**
                                 * Resets this block algorithm's data buffer to its initial state.
                                 *
                                 * @example
                                 *
                                 *     bufferedBlockAlgorithm.reset();
                                 */
                                reset: function () {
                                    this._data = new WordArray.init(), this._nDataBytes = 0;
                                },
                                /**
                                 * Adds new data to this block algorithm's buffer.
                                 *
                                 * @param {WordArray|string} data The data to append. Strings are converted to a WordArray using UTF-8.
                                 *
                                 * @example
                                 *
                                 *     bufferedBlockAlgorithm._append('data');
                                 *     bufferedBlockAlgorithm._append(wordArray);
                                 */
                                _append: function (data) {
                                    typeof data == "string" && (data = Utf8.parse(data)), this._data.concat(data), this._nDataBytes += data.sigBytes;
                                },
                                /**
                                 * Processes available data blocks.
                                 *
                                 * This method invokes _doProcessBlock(offset), which must be implemented by a concrete subtype.
                                 *
                                 * @param {boolean} doFlush Whether all blocks and partial blocks should be processed.
                                 *
                                 * @return {WordArray} The processed data.
                                 *
                                 * @example
                                 *
                                 *     var processedData = bufferedBlockAlgorithm._process();
                                 *     var processedData = bufferedBlockAlgorithm._process(!!'flush');
                                 */
                                _process: function (doFlush) {
                                    var processedWords, data = this._data, dataWords = data.words, dataSigBytes = data.sigBytes, blockSize = this.blockSize, blockSizeBytes = blockSize * 4, nBlocksReady = dataSigBytes / blockSizeBytes;
                                    doFlush ? nBlocksReady = Math2.ceil(nBlocksReady) : nBlocksReady = Math2.max((nBlocksReady | 0) - this._minBufferSize, 0);
                                    var nWordsReady = nBlocksReady * blockSize, nBytesReady = Math2.min(nWordsReady * 4, dataSigBytes);
                                    if (nWordsReady) {
                                        for (var offset = 0; offset < nWordsReady; offset += blockSize)
                                            this._doProcessBlock(dataWords, offset);
                                        processedWords = dataWords.splice(0, nWordsReady), data.sigBytes -= nBytesReady;
                                    }
                                    return new WordArray.init(processedWords, nBytesReady);
                                },
                                /**
                                 * Creates a copy of this object.
                                 *
                                 * @return {Object} The clone.
                                 *
                                 * @example
                                 *
                                 *     var clone = bufferedBlockAlgorithm.clone();
                                 */
                                clone: function () {
                                    var clone = Base.clone.call(this);
                                    return clone._data = this._data.clone(), clone;
                                },
                                _minBufferSize: 0
                            }), Hasher = C_lib.Hasher = BufferedBlockAlgorithm.extend({
                                /**
                                 * Configuration options.
                                 */
                                cfg: Base.extend(),
                                /**
                                 * Initializes a newly created hasher.
                                 *
                                 * @param {Object} cfg (Optional) The configuration options to use for this hash computation.
                                 *
                                 * @example
                                 *
                                 *     var hasher = CryptoJS.algo.SHA256.create();
                                 */
                                init: function (cfg) {
                                    this.cfg = this.cfg.extend(cfg), this.reset();
                                },
                                /**
                                 * Resets this hasher to its initial state.
                                 *
                                 * @example
                                 *
                                 *     hasher.reset();
                                 */
                                reset: function () {
                                    BufferedBlockAlgorithm.reset.call(this), this._doReset();
                                },
                                /**
                                 * Updates this hasher with a message.
                                 *
                                 * @param {WordArray|string} messageUpdate The message to append.
                                 *
                                 * @return {Hasher} This hasher.
                                 *
                                 * @example
                                 *
                                 *     hasher.update('message');
                                 *     hasher.update(wordArray);
                                 */
                                update: function (messageUpdate) {
                                    return this._append(messageUpdate), this._process(), this;
                                },
                                /**
                                 * Finalizes the hash computation.
                                 * Note that the finalize operation is effectively a destructive, read-once operation.
                                 *
                                 * @param {WordArray|string} messageUpdate (Optional) A final message update.
                                 *
                                 * @return {WordArray} The hash.
                                 *
                                 * @example
                                 *
                                 *     var hash = hasher.finalize();
                                 *     var hash = hasher.finalize('message');
                                 *     var hash = hasher.finalize(wordArray);
                                 */
                                finalize: function (messageUpdate) {
                                    messageUpdate && this._append(messageUpdate);
                                    var hash = this._doFinalize();
                                    return hash;
                                },
                                blockSize: 512 / 32,
                                /**
                                 * Creates a shortcut function to a hasher's object interface.
                                 *
                                 * @param {Hasher} hasher The hasher to create a helper for.
                                 *
                                 * @return {Function} The shortcut function.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var SHA256 = CryptoJS.lib.Hasher._createHelper(CryptoJS.algo.SHA256);
                                 */
                                _createHelper: function (hasher) {
                                    return function (message, cfg) {
                                        return new hasher.init(cfg).finalize(message);
                                    };
                                },
                                /**
                                 * Creates a shortcut function to the HMAC's object interface.
                                 *
                                 * @param {Hasher} hasher The hasher to use in this HMAC helper.
                                 *
                                 * @return {Function} The shortcut function.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var HmacSHA256 = CryptoJS.lib.Hasher._createHmacHelper(CryptoJS.algo.SHA256);
                                 */
                                _createHmacHelper: function (hasher) {
                                    return function (message, key) {
                                        return new C_algo.HMAC.init(hasher, key).finalize(message);
                                    };
                                }
                            }), C_algo = C.algo = {};
                            return C;
                        }(Math);
                        return CryptoJS;
                    });
                }
            });

            // node_modules/crypto-js/enc-base64.js
            var require_enc_base64 = __commonJS({
                "node_modules/crypto-js/enc-base64.js"(exports, module) {
                    (function (root, factory) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core()) : typeof define == "function" && define.amd ? define(["./core"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        return function () {
                            var C = CryptoJS, C_lib = C.lib, WordArray = C_lib.WordArray, C_enc = C.enc, Base64 = C_enc.Base64 = {
                                /**
                                 * Converts a word array to a Base64 string.
                                 *
                                 * @param {WordArray} wordArray The word array.
                                 *
                                 * @return {string} The Base64 string.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var base64String = CryptoJS.enc.Base64.stringify(wordArray);
                                 */
                                stringify: function (wordArray) {
                                    var words = wordArray.words, sigBytes = wordArray.sigBytes, map = this._map;
                                    wordArray.clamp();
                                    for (var base64Chars = [], i = 0; i < sigBytes; i += 3)
                                        for (var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255, byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255, byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255, triplet = byte1 << 16 | byte2 << 8 | byte3, j = 0; j < 4 && i + j * 0.75 < sigBytes; j++)
                                            base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));
                                    var paddingChar = map.charAt(64);
                                    if (paddingChar)
                                        for (; base64Chars.length % 4;)
                                            base64Chars.push(paddingChar);
                                    return base64Chars.join("");
                                },
                                /**
                                 * Converts a Base64 string to a word array.
                                 *
                                 * @param {string} base64Str The Base64 string.
                                 *
                                 * @return {WordArray} The word array.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var wordArray = CryptoJS.enc.Base64.parse(base64String);
                                 */
                                parse: function (base64Str) {
                                    var base64StrLength = base64Str.length, map = this._map, reverseMap = this._reverseMap;
                                    if (!reverseMap) {
                                        reverseMap = this._reverseMap = [];
                                        for (var j = 0; j < map.length; j++)
                                            reverseMap[map.charCodeAt(j)] = j;
                                    }
                                    var paddingChar = map.charAt(64);
                                    if (paddingChar) {
                                        var paddingIndex = base64Str.indexOf(paddingChar);
                                        paddingIndex !== -1 && (base64StrLength = paddingIndex);
                                    }
                                    return parseLoop(base64Str, base64StrLength, reverseMap);
                                },
                                _map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
                            };
                            function parseLoop(base64Str, base64StrLength, reverseMap) {
                                for (var words = [], nBytes = 0, i = 0; i < base64StrLength; i++)
                                    if (i % 4) {
                                        var bits1 = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2, bits2 = reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2, bitsCombined = bits1 | bits2;
                                        words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8, nBytes++;
                                    }
                                return WordArray.create(words, nBytes);
                            }
                        }(), CryptoJS.enc.Base64;
                    });
                }
            });

            // node_modules/crypto-js/md5.js
            var require_md5 = __commonJS({
                "node_modules/crypto-js/md5.js"(exports, module) {
                    (function (root, factory) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core()) : typeof define == "function" && define.amd ? define(["./core"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        return function (Math2) {
                            var C = CryptoJS, C_lib = C.lib, WordArray = C_lib.WordArray, Hasher = C_lib.Hasher, C_algo = C.algo, T = [];
                            (function () {
                                for (var i = 0; i < 64; i++)
                                    T[i] = Math2.abs(Math2.sin(i + 1)) * 4294967296 | 0;
                            })();
                            var MD5 = C_algo.MD5 = Hasher.extend({
                                _doReset: function () {
                                    this._hash = new WordArray.init([
                                        1732584193,
                                        4023233417,
                                        2562383102,
                                        271733878
                                    ]);
                                },
                                _doProcessBlock: function (M, offset) {
                                    for (var i = 0; i < 16; i++) {
                                        var offset_i = offset + i, M_offset_i = M[offset_i];
                                        M[offset_i] = (M_offset_i << 8 | M_offset_i >>> 24) & 16711935 | (M_offset_i << 24 | M_offset_i >>> 8) & 4278255360;
                                    }
                                    var H = this._hash.words, M_offset_0 = M[offset + 0], M_offset_1 = M[offset + 1], M_offset_2 = M[offset + 2], M_offset_3 = M[offset + 3], M_offset_4 = M[offset + 4], M_offset_5 = M[offset + 5], M_offset_6 = M[offset + 6], M_offset_7 = M[offset + 7], M_offset_8 = M[offset + 8], M_offset_9 = M[offset + 9], M_offset_10 = M[offset + 10], M_offset_11 = M[offset + 11], M_offset_12 = M[offset + 12], M_offset_13 = M[offset + 13], M_offset_14 = M[offset + 14], M_offset_15 = M[offset + 15], a = H[0], b = H[1], c = H[2], d = H[3];
                                    a = FF(a, b, c, d, M_offset_0, 7, T[0]), d = FF(d, a, b, c, M_offset_1, 12, T[1]), c = FF(c, d, a, b, M_offset_2, 17, T[2]), b = FF(b, c, d, a, M_offset_3, 22, T[3]), a = FF(a, b, c, d, M_offset_4, 7, T[4]), d = FF(d, a, b, c, M_offset_5, 12, T[5]), c = FF(c, d, a, b, M_offset_6, 17, T[6]), b = FF(b, c, d, a, M_offset_7, 22, T[7]), a = FF(a, b, c, d, M_offset_8, 7, T[8]), d = FF(d, a, b, c, M_offset_9, 12, T[9]), c = FF(c, d, a, b, M_offset_10, 17, T[10]), b = FF(b, c, d, a, M_offset_11, 22, T[11]), a = FF(a, b, c, d, M_offset_12, 7, T[12]), d = FF(d, a, b, c, M_offset_13, 12, T[13]), c = FF(c, d, a, b, M_offset_14, 17, T[14]), b = FF(b, c, d, a, M_offset_15, 22, T[15]), a = GG(a, b, c, d, M_offset_1, 5, T[16]), d = GG(d, a, b, c, M_offset_6, 9, T[17]), c = GG(c, d, a, b, M_offset_11, 14, T[18]), b = GG(b, c, d, a, M_offset_0, 20, T[19]), a = GG(a, b, c, d, M_offset_5, 5, T[20]), d = GG(d, a, b, c, M_offset_10, 9, T[21]), c = GG(c, d, a, b, M_offset_15, 14, T[22]), b = GG(b, c, d, a, M_offset_4, 20, T[23]), a = GG(a, b, c, d, M_offset_9, 5, T[24]), d = GG(d, a, b, c, M_offset_14, 9, T[25]), c = GG(c, d, a, b, M_offset_3, 14, T[26]), b = GG(b, c, d, a, M_offset_8, 20, T[27]), a = GG(a, b, c, d, M_offset_13, 5, T[28]), d = GG(d, a, b, c, M_offset_2, 9, T[29]), c = GG(c, d, a, b, M_offset_7, 14, T[30]), b = GG(b, c, d, a, M_offset_12, 20, T[31]), a = HH(a, b, c, d, M_offset_5, 4, T[32]), d = HH(d, a, b, c, M_offset_8, 11, T[33]), c = HH(c, d, a, b, M_offset_11, 16, T[34]), b = HH(b, c, d, a, M_offset_14, 23, T[35]), a = HH(a, b, c, d, M_offset_1, 4, T[36]), d = HH(d, a, b, c, M_offset_4, 11, T[37]), c = HH(c, d, a, b, M_offset_7, 16, T[38]), b = HH(b, c, d, a, M_offset_10, 23, T[39]), a = HH(a, b, c, d, M_offset_13, 4, T[40]), d = HH(d, a, b, c, M_offset_0, 11, T[41]), c = HH(c, d, a, b, M_offset_3, 16, T[42]), b = HH(b, c, d, a, M_offset_6, 23, T[43]), a = HH(a, b, c, d, M_offset_9, 4, T[44]), d = HH(d, a, b, c, M_offset_12, 11, T[45]), c = HH(c, d, a, b, M_offset_15, 16, T[46]), b = HH(b, c, d, a, M_offset_2, 23, T[47]), a = II(a, b, c, d, M_offset_0, 6, T[48]), d = II(d, a, b, c, M_offset_7, 10, T[49]), c = II(c, d, a, b, M_offset_14, 15, T[50]), b = II(b, c, d, a, M_offset_5, 21, T[51]), a = II(a, b, c, d, M_offset_12, 6, T[52]), d = II(d, a, b, c, M_offset_3, 10, T[53]), c = II(c, d, a, b, M_offset_10, 15, T[54]), b = II(b, c, d, a, M_offset_1, 21, T[55]), a = II(a, b, c, d, M_offset_8, 6, T[56]), d = II(d, a, b, c, M_offset_15, 10, T[57]), c = II(c, d, a, b, M_offset_6, 15, T[58]), b = II(b, c, d, a, M_offset_13, 21, T[59]), a = II(a, b, c, d, M_offset_4, 6, T[60]), d = II(d, a, b, c, M_offset_11, 10, T[61]), c = II(c, d, a, b, M_offset_2, 15, T[62]), b = II(b, c, d, a, M_offset_9, 21, T[63]), H[0] = H[0] + a | 0, H[1] = H[1] + b | 0, H[2] = H[2] + c | 0, H[3] = H[3] + d | 0;
                                },
                                _doFinalize: function () {
                                    var data = this._data, dataWords = data.words, nBitsTotal = this._nDataBytes * 8, nBitsLeft = data.sigBytes * 8;
                                    dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
                                    var nBitsTotalH = Math2.floor(nBitsTotal / 4294967296), nBitsTotalL = nBitsTotal;
                                    dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = (nBitsTotalH << 8 | nBitsTotalH >>> 24) & 16711935 | (nBitsTotalH << 24 | nBitsTotalH >>> 8) & 4278255360, dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = (nBitsTotalL << 8 | nBitsTotalL >>> 24) & 16711935 | (nBitsTotalL << 24 | nBitsTotalL >>> 8) & 4278255360, data.sigBytes = (dataWords.length + 1) * 4, this._process();
                                    for (var hash = this._hash, H = hash.words, i = 0; i < 4; i++) {
                                        var H_i = H[i];
                                        H[i] = (H_i << 8 | H_i >>> 24) & 16711935 | (H_i << 24 | H_i >>> 8) & 4278255360;
                                    }
                                    return hash;
                                },
                                clone: function () {
                                    var clone = Hasher.clone.call(this);
                                    return clone._hash = this._hash.clone(), clone;
                                }
                            });
                            function FF(a, b, c, d, x, s, t) {
                                var n = a + (b & c | ~b & d) + x + t;
                                return (n << s | n >>> 32 - s) + b;
                            }
                            function GG(a, b, c, d, x, s, t) {
                                var n = a + (b & d | c & ~d) + x + t;
                                return (n << s | n >>> 32 - s) + b;
                            }
                            function HH(a, b, c, d, x, s, t) {
                                var n = a + (b ^ c ^ d) + x + t;
                                return (n << s | n >>> 32 - s) + b;
                            }
                            function II(a, b, c, d, x, s, t) {
                                var n = a + (c ^ (b | ~d)) + x + t;
                                return (n << s | n >>> 32 - s) + b;
                            }
                            C.MD5 = Hasher._createHelper(MD5), C.HmacMD5 = Hasher._createHmacHelper(MD5);
                        }(Math), CryptoJS.MD5;
                    });
                }
            });

            // node_modules/crypto-js/sha1.js
            var require_sha1 = __commonJS({
                "node_modules/crypto-js/sha1.js"(exports, module) {
                    (function (root, factory) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core()) : typeof define == "function" && define.amd ? define(["./core"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        return function () {
                            var C = CryptoJS, C_lib = C.lib, WordArray = C_lib.WordArray, Hasher = C_lib.Hasher, C_algo = C.algo, W = [], SHA1 = C_algo.SHA1 = Hasher.extend({
                                _doReset: function () {
                                    this._hash = new WordArray.init([
                                        1732584193,
                                        4023233417,
                                        2562383102,
                                        271733878,
                                        3285377520
                                    ]);
                                },
                                _doProcessBlock: function (M, offset) {
                                    for (var H = this._hash.words, a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], i = 0; i < 80; i++) {
                                        if (i < 16)
                                            W[i] = M[offset + i] | 0;
                                        else {
                                            var n = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
                                            W[i] = n << 1 | n >>> 31;
                                        }
                                        var t = (a << 5 | a >>> 27) + e + W[i];
                                        i < 20 ? t += (b & c | ~b & d) + 1518500249 : i < 40 ? t += (b ^ c ^ d) + 1859775393 : i < 60 ? t += (b & c | b & d | c & d) - 1894007588 : t += (b ^ c ^ d) - 899497514, e = d, d = c, c = b << 30 | b >>> 2, b = a, a = t;
                                    }
                                    H[0] = H[0] + a | 0, H[1] = H[1] + b | 0, H[2] = H[2] + c | 0, H[3] = H[3] + d | 0, H[4] = H[4] + e | 0;
                                },
                                _doFinalize: function () {
                                    var data = this._data, dataWords = data.words, nBitsTotal = this._nDataBytes * 8, nBitsLeft = data.sigBytes * 8;
                                    return dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32, dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = Math.floor(nBitsTotal / 4294967296), dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = nBitsTotal, data.sigBytes = dataWords.length * 4, this._process(), this._hash;
                                },
                                clone: function () {
                                    var clone = Hasher.clone.call(this);
                                    return clone._hash = this._hash.clone(), clone;
                                }
                            });
                            C.SHA1 = Hasher._createHelper(SHA1), C.HmacSHA1 = Hasher._createHmacHelper(SHA1);
                        }(), CryptoJS.SHA1;
                    });
                }
            });

            // node_modules/crypto-js/hmac.js
            var require_hmac = __commonJS({
                "node_modules/crypto-js/hmac.js"(exports, module) {
                    (function (root, factory) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core()) : typeof define == "function" && define.amd ? define(["./core"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        (function () {
                            var C = CryptoJS, C_lib = C.lib, Base = C_lib.Base, C_enc = C.enc, Utf8 = C_enc.Utf8, C_algo = C.algo, HMAC = C_algo.HMAC = Base.extend({
                                /**
                                 * Initializes a newly created HMAC.
                                 *
                                 * @param {Hasher} hasher The hash algorithm to use.
                                 * @param {WordArray|string} key The secret key.
                                 *
                                 * @example
                                 *
                                 *     var hmacHasher = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA256, key);
                                 */
                                init: function (hasher, key) {
                                    hasher = this._hasher = new hasher.init(), typeof key == "string" && (key = Utf8.parse(key));
                                    var hasherBlockSize = hasher.blockSize, hasherBlockSizeBytes = hasherBlockSize * 4;
                                    key.sigBytes > hasherBlockSizeBytes && (key = hasher.finalize(key)), key.clamp();
                                    for (var oKey = this._oKey = key.clone(), iKey = this._iKey = key.clone(), oKeyWords = oKey.words, iKeyWords = iKey.words, i = 0; i < hasherBlockSize; i++)
                                        oKeyWords[i] ^= 1549556828, iKeyWords[i] ^= 909522486;
                                    oKey.sigBytes = iKey.sigBytes = hasherBlockSizeBytes, this.reset();
                                },
                                /**
                                 * Resets this HMAC to its initial state.
                                 *
                                 * @example
                                 *
                                 *     hmacHasher.reset();
                                 */
                                reset: function () {
                                    var hasher = this._hasher;
                                    hasher.reset(), hasher.update(this._iKey);
                                },
                                /**
                                 * Updates this HMAC with a message.
                                 *
                                 * @param {WordArray|string} messageUpdate The message to append.
                                 *
                                 * @return {HMAC} This HMAC instance.
                                 *
                                 * @example
                                 *
                                 *     hmacHasher.update('message');
                                 *     hmacHasher.update(wordArray);
                                 */
                                update: function (messageUpdate) {
                                    return this._hasher.update(messageUpdate), this;
                                },
                                /**
                                 * Finalizes the HMAC computation.
                                 * Note that the finalize operation is effectively a destructive, read-once operation.
                                 *
                                 * @param {WordArray|string} messageUpdate (Optional) A final message update.
                                 *
                                 * @return {WordArray} The HMAC.
                                 *
                                 * @example
                                 *
                                 *     var hmac = hmacHasher.finalize();
                                 *     var hmac = hmacHasher.finalize('message');
                                 *     var hmac = hmacHasher.finalize(wordArray);
                                 */
                                finalize: function (messageUpdate) {
                                    var hasher = this._hasher, innerHash = hasher.finalize(messageUpdate);
                                    hasher.reset();
                                    var hmac = hasher.finalize(this._oKey.clone().concat(innerHash));
                                    return hmac;
                                }
                            });
                        })();
                    });
                }
            });

            // node_modules/crypto-js/evpkdf.js
            var require_evpkdf = __commonJS({
                "node_modules/crypto-js/evpkdf.js"(exports, module) {
                    (function (root, factory, undef) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core(), require_sha1(), require_hmac()) : typeof define == "function" && define.amd ? define(["./core", "./sha1", "./hmac"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        return function () {
                            var C = CryptoJS, C_lib = C.lib, Base = C_lib.Base, WordArray = C_lib.WordArray, C_algo = C.algo, MD5 = C_algo.MD5, EvpKDF = C_algo.EvpKDF = Base.extend({
                                /**
                                 * Configuration options.
                                 *
                                 * @property {number} keySize The key size in words to generate. Default: 4 (128 bits)
                                 * @property {Hasher} hasher The hash algorithm to use. Default: MD5
                                 * @property {number} iterations The number of iterations to perform. Default: 1
                                 */
                                cfg: Base.extend({
                                    keySize: 128 / 32,
                                    hasher: MD5,
                                    iterations: 1
                                }),
                                /**
                                 * Initializes a newly created key derivation function.
                                 *
                                 * @param {Object} cfg (Optional) The configuration options to use for the derivation.
                                 *
                                 * @example
                                 *
                                 *     var kdf = CryptoJS.algo.EvpKDF.create();
                                 *     var kdf = CryptoJS.algo.EvpKDF.create({ keySize: 8 });
                                 *     var kdf = CryptoJS.algo.EvpKDF.create({ keySize: 8, iterations: 1000 });
                                 */
                                init: function (cfg) {
                                    this.cfg = this.cfg.extend(cfg);
                                },
                                /**
                                 * Derives a key from a password.
                                 *
                                 * @param {WordArray|string} password The password.
                                 * @param {WordArray|string} salt A salt.
                                 *
                                 * @return {WordArray} The derived key.
                                 *
                                 * @example
                                 *
                                 *     var key = kdf.compute(password, salt);
                                 */
                                compute: function (password, salt) {
                                    for (var block, cfg = this.cfg, hasher = cfg.hasher.create(), derivedKey = WordArray.create(), derivedKeyWords = derivedKey.words, keySize = cfg.keySize, iterations = cfg.iterations; derivedKeyWords.length < keySize;) {
                                        block && hasher.update(block), block = hasher.update(password).finalize(salt), hasher.reset();
                                        for (var i = 1; i < iterations; i++)
                                            block = hasher.finalize(block), hasher.reset();
                                        derivedKey.concat(block);
                                    }
                                    return derivedKey.sigBytes = keySize * 4, derivedKey;
                                }
                            });
                            C.EvpKDF = function (password, salt, cfg) {
                                return EvpKDF.create(cfg).compute(password, salt);
                            };
                        }(), CryptoJS.EvpKDF;
                    });
                }
            });

            // node_modules/crypto-js/cipher-core.js
            var require_cipher_core = __commonJS({
                "node_modules/crypto-js/cipher-core.js"(exports, module) {
                    (function (root, factory, undef) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core(), require_evpkdf()) : typeof define == "function" && define.amd ? define(["./core", "./evpkdf"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        CryptoJS.lib.Cipher || function (undefined) {
                            var C = CryptoJS, C_lib = C.lib, Base = C_lib.Base, WordArray = C_lib.WordArray, BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm, C_enc = C.enc, Utf8 = C_enc.Utf8, Base64 = C_enc.Base64, C_algo = C.algo, EvpKDF = C_algo.EvpKDF, Cipher = C_lib.Cipher = BufferedBlockAlgorithm.extend({
                                /**
                                 * Configuration options.
                                 *
                                 * @property {WordArray} iv The IV to use for this operation.
                                 */
                                cfg: Base.extend(),
                                /**
                                 * Creates this cipher in encryption mode.
                                 *
                                 * @param {WordArray} key The key.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @return {Cipher} A cipher instance.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var cipher = CryptoJS.algo.AES.createEncryptor(keyWordArray, { iv: ivWordArray });
                                 */
                                createEncryptor: function (key, cfg) {
                                    return this.create(this._ENC_XFORM_MODE, key, cfg);
                                },
                                /**
                                 * Creates this cipher in decryption mode.
                                 *
                                 * @param {WordArray} key The key.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @return {Cipher} A cipher instance.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var cipher = CryptoJS.algo.AES.createDecryptor(keyWordArray, { iv: ivWordArray });
                                 */
                                createDecryptor: function (key, cfg) {
                                    return this.create(this._DEC_XFORM_MODE, key, cfg);
                                },
                                /**
                                 * Initializes a newly created cipher.
                                 *
                                 * @param {number} xformMode Either the encryption or decryption transormation mode constant.
                                 * @param {WordArray} key The key.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @example
                                 *
                                 *     var cipher = CryptoJS.algo.AES.create(CryptoJS.algo.AES._ENC_XFORM_MODE, keyWordArray, { iv: ivWordArray });
                                 */
                                init: function (xformMode, key, cfg) {
                                    this.cfg = this.cfg.extend(cfg), this._xformMode = xformMode, this._key = key, this.reset();
                                },
                                /**
                                 * Resets this cipher to its initial state.
                                 *
                                 * @example
                                 *
                                 *     cipher.reset();
                                 */
                                reset: function () {
                                    BufferedBlockAlgorithm.reset.call(this), this._doReset();
                                },
                                /**
                                 * Adds data to be encrypted or decrypted.
                                 *
                                 * @param {WordArray|string} dataUpdate The data to encrypt or decrypt.
                                 *
                                 * @return {WordArray} The data after processing.
                                 *
                                 * @example
                                 *
                                 *     var encrypted = cipher.process('data');
                                 *     var encrypted = cipher.process(wordArray);
                                 */
                                process: function (dataUpdate) {
                                    return this._append(dataUpdate), this._process();
                                },
                                /**
                                 * Finalizes the encryption or decryption process.
                                 * Note that the finalize operation is effectively a destructive, read-once operation.
                                 *
                                 * @param {WordArray|string} dataUpdate The final data to encrypt or decrypt.
                                 *
                                 * @return {WordArray} The data after final processing.
                                 *
                                 * @example
                                 *
                                 *     var encrypted = cipher.finalize();
                                 *     var encrypted = cipher.finalize('data');
                                 *     var encrypted = cipher.finalize(wordArray);
                                 */
                                finalize: function (dataUpdate) {
                                    dataUpdate && this._append(dataUpdate);
                                    var finalProcessedData = this._doFinalize();
                                    return finalProcessedData;
                                },
                                keySize: 128 / 32,
                                ivSize: 128 / 32,
                                _ENC_XFORM_MODE: 1,
                                _DEC_XFORM_MODE: 2,
                                /**
                                 * Creates shortcut functions to a cipher's object interface.
                                 *
                                 * @param {Cipher} cipher The cipher to create a helper for.
                                 *
                                 * @return {Object} An object with encrypt and decrypt shortcut functions.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var AES = CryptoJS.lib.Cipher._createHelper(CryptoJS.algo.AES);
                                 */
                                _createHelper: /* @__PURE__ */ function () {
                                    function selectCipherStrategy(key) {
                                        return typeof key == "string" ? PasswordBasedCipher : SerializableCipher;
                                    }
                                    return function (cipher) {
                                        return {
                                            encrypt: function (message, key, cfg) {
                                                return selectCipherStrategy(key).encrypt(cipher, message, key, cfg);
                                            },
                                            decrypt: function (ciphertext, key, cfg) {
                                                return selectCipherStrategy(key).decrypt(cipher, ciphertext, key, cfg);
                                            }
                                        };
                                    };
                                }()
                            }), StreamCipher = C_lib.StreamCipher = Cipher.extend({
                                _doFinalize: function () {
                                    var finalProcessedBlocks = this._process(!0);
                                    return finalProcessedBlocks;
                                },
                                blockSize: 1
                            }), C_mode = C.mode = {}, BlockCipherMode = C_lib.BlockCipherMode = Base.extend({
                                /**
                                 * Creates this mode for encryption.
                                 *
                                 * @param {Cipher} cipher A block cipher instance.
                                 * @param {Array} iv The IV words.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var mode = CryptoJS.mode.CBC.createEncryptor(cipher, iv.words);
                                 */
                                createEncryptor: function (cipher, iv) {
                                    return this.Encryptor.create(cipher, iv);
                                },
                                /**
                                 * Creates this mode for decryption.
                                 *
                                 * @param {Cipher} cipher A block cipher instance.
                                 * @param {Array} iv The IV words.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var mode = CryptoJS.mode.CBC.createDecryptor(cipher, iv.words);
                                 */
                                createDecryptor: function (cipher, iv) {
                                    return this.Decryptor.create(cipher, iv);
                                },
                                /**
                                 * Initializes a newly created mode.
                                 *
                                 * @param {Cipher} cipher A block cipher instance.
                                 * @param {Array} iv The IV words.
                                 *
                                 * @example
                                 *
                                 *     var mode = CryptoJS.mode.CBC.Encryptor.create(cipher, iv.words);
                                 */
                                init: function (cipher, iv) {
                                    this._cipher = cipher, this._iv = iv;
                                }
                            }), CBC = C_mode.CBC = function () {
                                var CBC2 = BlockCipherMode.extend();
                                CBC2.Encryptor = CBC2.extend({
                                    /**
                                     * Processes the data block at offset.
                                     *
                                     * @param {Array} words The data words to operate on.
                                     * @param {number} offset The offset where the block starts.
                                     *
                                     * @example
                                     *
                                     *     mode.processBlock(data.words, offset);
                                     */
                                    processBlock: function (words, offset) {
                                        var cipher = this._cipher, blockSize = cipher.blockSize;
                                        xorBlock.call(this, words, offset, blockSize), cipher.encryptBlock(words, offset), this._prevBlock = words.slice(offset, offset + blockSize);
                                    }
                                }), CBC2.Decryptor = CBC2.extend({
                                    /**
                                     * Processes the data block at offset.
                                     *
                                     * @param {Array} words The data words to operate on.
                                     * @param {number} offset The offset where the block starts.
                                     *
                                     * @example
                                     *
                                     *     mode.processBlock(data.words, offset);
                                     */
                                    processBlock: function (words, offset) {
                                        var cipher = this._cipher, blockSize = cipher.blockSize, thisBlock = words.slice(offset, offset + blockSize);
                                        cipher.decryptBlock(words, offset), xorBlock.call(this, words, offset, blockSize), this._prevBlock = thisBlock;
                                    }
                                });
                                function xorBlock(words, offset, blockSize) {
                                    var block, iv = this._iv;
                                    iv ? (block = iv, this._iv = undefined) : block = this._prevBlock;
                                    for (var i = 0; i < blockSize; i++)
                                        words[offset + i] ^= block[i];
                                }
                                return CBC2;
                            }(), C_pad = C.pad = {}, Pkcs7 = C_pad.Pkcs7 = {
                                /**
                                 * Pads data using the algorithm defined in PKCS #5/7.
                                 *
                                 * @param {WordArray} data The data to pad.
                                 * @param {number} blockSize The multiple that the data should be padded to.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     CryptoJS.pad.Pkcs7.pad(wordArray, 4);
                                 */
                                pad: function (data, blockSize) {
                                    for (var blockSizeBytes = blockSize * 4, nPaddingBytes = blockSizeBytes - data.sigBytes % blockSizeBytes, paddingWord = nPaddingBytes << 24 | nPaddingBytes << 16 | nPaddingBytes << 8 | nPaddingBytes, paddingWords = [], i = 0; i < nPaddingBytes; i += 4)
                                        paddingWords.push(paddingWord);
                                    var padding = WordArray.create(paddingWords, nPaddingBytes);
                                    data.concat(padding);
                                },
                                /**
                                 * Unpads data that had been padded using the algorithm defined in PKCS #5/7.
                                 *
                                 * @param {WordArray} data The data to unpad.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     CryptoJS.pad.Pkcs7.unpad(wordArray);
                                 */
                                unpad: function (data) {
                                    var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
                                    data.sigBytes -= nPaddingBytes;
                                }
                            }, BlockCipher = C_lib.BlockCipher = Cipher.extend({
                                /**
                                 * Configuration options.
                                 *
                                 * @property {Mode} mode The block mode to use. Default: CBC
                                 * @property {Padding} padding The padding strategy to use. Default: Pkcs7
                                 */
                                cfg: Cipher.cfg.extend({
                                    mode: CBC,
                                    padding: Pkcs7
                                }),
                                reset: function () {
                                    var modeCreator;
                                    Cipher.reset.call(this);
                                    var cfg = this.cfg, iv = cfg.iv, mode = cfg.mode;
                                    this._xformMode == this._ENC_XFORM_MODE ? modeCreator = mode.createEncryptor : (modeCreator = mode.createDecryptor, this._minBufferSize = 1), this._mode && this._mode.__creator == modeCreator ? this._mode.init(this, iv && iv.words) : (this._mode = modeCreator.call(mode, this, iv && iv.words), this._mode.__creator = modeCreator);
                                },
                                _doProcessBlock: function (words, offset) {
                                    this._mode.processBlock(words, offset);
                                },
                                _doFinalize: function () {
                                    var finalProcessedBlocks, padding = this.cfg.padding;
                                    return this._xformMode == this._ENC_XFORM_MODE ? (padding.pad(this._data, this.blockSize), finalProcessedBlocks = this._process(!0)) : (finalProcessedBlocks = this._process(!0), padding.unpad(finalProcessedBlocks)), finalProcessedBlocks;
                                },
                                blockSize: 128 / 32
                            }), CipherParams = C_lib.CipherParams = Base.extend({
                                /**
                                 * Initializes a newly created cipher params object.
                                 *
                                 * @param {Object} cipherParams An object with any of the possible cipher parameters.
                                 *
                                 * @example
                                 *
                                 *     var cipherParams = CryptoJS.lib.CipherParams.create({
                                 *         ciphertext: ciphertextWordArray,
                                 *         key: keyWordArray,
                                 *         iv: ivWordArray,
                                 *         salt: saltWordArray,
                                 *         algorithm: CryptoJS.algo.AES,
                                 *         mode: CryptoJS.mode.CBC,
                                 *         padding: CryptoJS.pad.PKCS7,
                                 *         blockSize: 4,
                                 *         formatter: CryptoJS.format.OpenSSL
                                 *     });
                                 */
                                init: function (cipherParams) {
                                    this.mixIn(cipherParams);
                                },
                                /**
                                 * Converts this cipher params object to a string.
                                 *
                                 * @param {Format} formatter (Optional) The formatting strategy to use.
                                 *
                                 * @return {string} The stringified cipher params.
                                 *
                                 * @throws Error If neither the formatter nor the default formatter is set.
                                 *
                                 * @example
                                 *
                                 *     var string = cipherParams + '';
                                 *     var string = cipherParams.toString();
                                 *     var string = cipherParams.toString(CryptoJS.format.OpenSSL);
                                 */
                                toString: function (formatter) {
                                    return (formatter || this.formatter).stringify(this);
                                }
                            }), C_format = C.format = {}, OpenSSLFormatter = C_format.OpenSSL = {
                                /**
                                 * Converts a cipher params object to an OpenSSL-compatible string.
                                 *
                                 * @param {CipherParams} cipherParams The cipher params object.
                                 *
                                 * @return {string} The OpenSSL-compatible string.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var openSSLString = CryptoJS.format.OpenSSL.stringify(cipherParams);
                                 */
                                stringify: function (cipherParams) {
                                    var wordArray, ciphertext = cipherParams.ciphertext, salt = cipherParams.salt;
                                    return salt ? wordArray = WordArray.create([1398893684, 1701076831]).concat(salt).concat(ciphertext) : wordArray = ciphertext, wordArray.toString(Base64);
                                },
                                /**
                                 * Converts an OpenSSL-compatible string to a cipher params object.
                                 *
                                 * @param {string} openSSLStr The OpenSSL-compatible string.
                                 *
                                 * @return {CipherParams} The cipher params object.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var cipherParams = CryptoJS.format.OpenSSL.parse(openSSLString);
                                 */
                                parse: function (openSSLStr) {
                                    var salt, ciphertext = Base64.parse(openSSLStr), ciphertextWords = ciphertext.words;
                                    return ciphertextWords[0] == 1398893684 && ciphertextWords[1] == 1701076831 && (salt = WordArray.create(ciphertextWords.slice(2, 4)), ciphertextWords.splice(0, 4), ciphertext.sigBytes -= 16), CipherParams.create({ ciphertext, salt });
                                }
                            }, SerializableCipher = C_lib.SerializableCipher = Base.extend({
                                /**
                                 * Configuration options.
                                 *
                                 * @property {Formatter} format The formatting strategy to convert cipher param objects to and from a string. Default: OpenSSL
                                 */
                                cfg: Base.extend({
                                    format: OpenSSLFormatter
                                }),
                                /**
                                 * Encrypts a message.
                                 *
                                 * @param {Cipher} cipher The cipher algorithm to use.
                                 * @param {WordArray|string} message The message to encrypt.
                                 * @param {WordArray} key The key.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @return {CipherParams} A cipher params object.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var ciphertextParams = CryptoJS.lib.SerializableCipher.encrypt(CryptoJS.algo.AES, message, key);
                                 *     var ciphertextParams = CryptoJS.lib.SerializableCipher.encrypt(CryptoJS.algo.AES, message, key, { iv: iv });
                                 *     var ciphertextParams = CryptoJS.lib.SerializableCipher.encrypt(CryptoJS.algo.AES, message, key, { iv: iv, format: CryptoJS.format.OpenSSL });
                                 */
                                encrypt: function (cipher, message, key, cfg) {
                                    cfg = this.cfg.extend(cfg);
                                    var encryptor = cipher.createEncryptor(key, cfg), ciphertext = encryptor.finalize(message), cipherCfg = encryptor.cfg;
                                    return CipherParams.create({
                                        ciphertext,
                                        key,
                                        iv: cipherCfg.iv,
                                        algorithm: cipher,
                                        mode: cipherCfg.mode,
                                        padding: cipherCfg.padding,
                                        blockSize: cipher.blockSize,
                                        formatter: cfg.format
                                    });
                                },
                                /**
                                 * Decrypts serialized ciphertext.
                                 *
                                 * @param {Cipher} cipher The cipher algorithm to use.
                                 * @param {CipherParams|string} ciphertext The ciphertext to decrypt.
                                 * @param {WordArray} key The key.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @return {WordArray} The plaintext.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var plaintext = CryptoJS.lib.SerializableCipher.decrypt(CryptoJS.algo.AES, formattedCiphertext, key, { iv: iv, format: CryptoJS.format.OpenSSL });
                                 *     var plaintext = CryptoJS.lib.SerializableCipher.decrypt(CryptoJS.algo.AES, ciphertextParams, key, { iv: iv, format: CryptoJS.format.OpenSSL });
                                 */
                                decrypt: function (cipher, ciphertext, key, cfg) {
                                    cfg = this.cfg.extend(cfg), ciphertext = this._parse(ciphertext, cfg.format);
                                    var plaintext = cipher.createDecryptor(key, cfg).finalize(ciphertext.ciphertext);
                                    return plaintext;
                                },
                                /**
                                 * Converts serialized ciphertext to CipherParams,
                                 * else assumed CipherParams already and returns ciphertext unchanged.
                                 *
                                 * @param {CipherParams|string} ciphertext The ciphertext.
                                 * @param {Formatter} format The formatting strategy to use to parse serialized ciphertext.
                                 *
                                 * @return {CipherParams} The unserialized ciphertext.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var ciphertextParams = CryptoJS.lib.SerializableCipher._parse(ciphertextStringOrParams, format);
                                 */
                                _parse: function (ciphertext, format) {
                                    return typeof ciphertext == "string" ? format.parse(ciphertext, this) : ciphertext;
                                }
                            }), C_kdf = C.kdf = {}, OpenSSLKdf = C_kdf.OpenSSL = {
                                /**
                                 * Derives a key and IV from a password.
                                 *
                                 * @param {string} password The password to derive from.
                                 * @param {number} keySize The size in words of the key to generate.
                                 * @param {number} ivSize The size in words of the IV to generate.
                                 * @param {WordArray|string} salt (Optional) A 64-bit salt to use. If omitted, a salt will be generated randomly.
                                 *
                                 * @return {CipherParams} A cipher params object with the key, IV, and salt.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var derivedParams = CryptoJS.kdf.OpenSSL.execute('Password', 256/32, 128/32);
                                 *     var derivedParams = CryptoJS.kdf.OpenSSL.execute('Password', 256/32, 128/32, 'saltsalt');
                                 */
                                execute: function (password, keySize, ivSize, salt, hasher) {
                                    if (salt || (salt = WordArray.random(64 / 8)), hasher)
                                        var key = EvpKDF.create({ keySize: keySize + ivSize, hasher }).compute(password, salt);
                                    else
                                        var key = EvpKDF.create({ keySize: keySize + ivSize }).compute(password, salt);
                                    var iv = WordArray.create(key.words.slice(keySize), ivSize * 4);
                                    return key.sigBytes = keySize * 4, CipherParams.create({ key, iv, salt });
                                }
                            }, PasswordBasedCipher = C_lib.PasswordBasedCipher = SerializableCipher.extend({
                                /**
                                 * Configuration options.
                                 *
                                 * @property {KDF} kdf The key derivation function to use to generate a key and IV from a password. Default: OpenSSL
                                 */
                                cfg: SerializableCipher.cfg.extend({
                                    kdf: OpenSSLKdf
                                }),
                                /**
                                 * Encrypts a message using a password.
                                 *
                                 * @param {Cipher} cipher The cipher algorithm to use.
                                 * @param {WordArray|string} message The message to encrypt.
                                 * @param {string} password The password.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @return {CipherParams} A cipher params object.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var ciphertextParams = CryptoJS.lib.PasswordBasedCipher.encrypt(CryptoJS.algo.AES, message, 'password');
                                 *     var ciphertextParams = CryptoJS.lib.PasswordBasedCipher.encrypt(CryptoJS.algo.AES, message, 'password', { format: CryptoJS.format.OpenSSL });
                                 */
                                encrypt: function (cipher, message, password, cfg) {
                                    cfg = this.cfg.extend(cfg);
                                    var derivedParams = cfg.kdf.execute(password, cipher.keySize, cipher.ivSize, cfg.salt, cfg.hasher);
                                    cfg.iv = derivedParams.iv;
                                    var ciphertext = SerializableCipher.encrypt.call(this, cipher, message, derivedParams.key, cfg);
                                    return ciphertext.mixIn(derivedParams), ciphertext;
                                },
                                /**
                                 * Decrypts serialized ciphertext using a password.
                                 *
                                 * @param {Cipher} cipher The cipher algorithm to use.
                                 * @param {CipherParams|string} ciphertext The ciphertext to decrypt.
                                 * @param {string} password The password.
                                 * @param {Object} cfg (Optional) The configuration options to use for this operation.
                                 *
                                 * @return {WordArray} The plaintext.
                                 *
                                 * @static
                                 *
                                 * @example
                                 *
                                 *     var plaintext = CryptoJS.lib.PasswordBasedCipher.decrypt(CryptoJS.algo.AES, formattedCiphertext, 'password', { format: CryptoJS.format.OpenSSL });
                                 *     var plaintext = CryptoJS.lib.PasswordBasedCipher.decrypt(CryptoJS.algo.AES, ciphertextParams, 'password', { format: CryptoJS.format.OpenSSL });
                                 */
                                decrypt: function (cipher, ciphertext, password, cfg) {
                                    cfg = this.cfg.extend(cfg), ciphertext = this._parse(ciphertext, cfg.format);
                                    var derivedParams = cfg.kdf.execute(password, cipher.keySize, cipher.ivSize, ciphertext.salt, cfg.hasher);
                                    cfg.iv = derivedParams.iv;
                                    var plaintext = SerializableCipher.decrypt.call(this, cipher, ciphertext, derivedParams.key, cfg);
                                    return plaintext;
                                }
                            });
                        }();
                    });
                }
            });

            // node_modules/crypto-js/aes.js
            var require_aes = __commonJS({
                "node_modules/crypto-js/aes.js"(exports, module) {
                    (function (root, factory, undef) {
                        typeof exports == "object" ? module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core()) : typeof define == "function" && define.amd ? define(["./core", "./enc-base64", "./md5", "./evpkdf", "./cipher-core"], factory) : factory(root.CryptoJS);
                    })(exports, function (CryptoJS) {
                        return function () {
                            var C = CryptoJS, C_lib = C.lib, BlockCipher = C_lib.BlockCipher, C_algo = C.algo, SBOX = [], INV_SBOX = [], SUB_MIX_0 = [], SUB_MIX_1 = [], SUB_MIX_2 = [], SUB_MIX_3 = [], INV_SUB_MIX_0 = [], INV_SUB_MIX_1 = [], INV_SUB_MIX_2 = [], INV_SUB_MIX_3 = [];
                            (function () {
                                for (var d = [], i = 0; i < 256; i++)
                                    i < 128 ? d[i] = i << 1 : d[i] = i << 1 ^ 283;
                                for (var x = 0, xi = 0, i = 0; i < 256; i++) {
                                    var sx = xi ^ xi << 1 ^ xi << 2 ^ xi << 3 ^ xi << 4;
                                    sx = sx >>> 8 ^ sx & 255 ^ 99, SBOX[x] = sx, INV_SBOX[sx] = x;
                                    var x2 = d[x], x4 = d[x2], x8 = d[x4], t = d[sx] * 257 ^ sx * 16843008;
                                    SUB_MIX_0[x] = t << 24 | t >>> 8, SUB_MIX_1[x] = t << 16 | t >>> 16, SUB_MIX_2[x] = t << 8 | t >>> 24, SUB_MIX_3[x] = t;
                                    var t = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
                                    INV_SUB_MIX_0[sx] = t << 24 | t >>> 8, INV_SUB_MIX_1[sx] = t << 16 | t >>> 16, INV_SUB_MIX_2[sx] = t << 8 | t >>> 24, INV_SUB_MIX_3[sx] = t, x ? (x = x2 ^ d[d[d[x8 ^ x2]]], xi ^= d[d[xi]]) : x = xi = 1;
                                }
                            })();
                            var RCON = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54], AES = C_algo.AES = BlockCipher.extend({
                                _doReset: function () {
                                    var t;
                                    if (!(this._nRounds && this._keyPriorReset === this._key)) {
                                        for (var key = this._keyPriorReset = this._key, keyWords = key.words, keySize = key.sigBytes / 4, nRounds = this._nRounds = keySize + 6, ksRows = (nRounds + 1) * 4, keySchedule = this._keySchedule = [], ksRow = 0; ksRow < ksRows; ksRow++)
                                            ksRow < keySize ? keySchedule[ksRow] = keyWords[ksRow] : (t = keySchedule[ksRow - 1], ksRow % keySize ? keySize > 6 && ksRow % keySize == 4 && (t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 255] << 16 | SBOX[t >>> 8 & 255] << 8 | SBOX[t & 255]) : (t = t << 8 | t >>> 24, t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 255] << 16 | SBOX[t >>> 8 & 255] << 8 | SBOX[t & 255], t ^= RCON[ksRow / keySize | 0] << 24), keySchedule[ksRow] = keySchedule[ksRow - keySize] ^ t);
                                        for (var invKeySchedule = this._invKeySchedule = [], invKsRow = 0; invKsRow < ksRows; invKsRow++) {
                                            var ksRow = ksRows - invKsRow;
                                            if (invKsRow % 4)
                                                var t = keySchedule[ksRow];
                                            else
                                                var t = keySchedule[ksRow - 4];
                                            invKsRow < 4 || ksRow <= 4 ? invKeySchedule[invKsRow] = t : invKeySchedule[invKsRow] = INV_SUB_MIX_0[SBOX[t >>> 24]] ^ INV_SUB_MIX_1[SBOX[t >>> 16 & 255]] ^ INV_SUB_MIX_2[SBOX[t >>> 8 & 255]] ^ INV_SUB_MIX_3[SBOX[t & 255]];
                                        }
                                    }
                                },
                                encryptBlock: function (M, offset) {
                                    this._doCryptBlock(M, offset, this._keySchedule, SUB_MIX_0, SUB_MIX_1, SUB_MIX_2, SUB_MIX_3, SBOX);
                                },
                                decryptBlock: function (M, offset) {
                                    var t = M[offset + 1];
                                    M[offset + 1] = M[offset + 3], M[offset + 3] = t, this._doCryptBlock(M, offset, this._invKeySchedule, INV_SUB_MIX_0, INV_SUB_MIX_1, INV_SUB_MIX_2, INV_SUB_MIX_3, INV_SBOX);
                                    var t = M[offset + 1];
                                    M[offset + 1] = M[offset + 3], M[offset + 3] = t;
                                },
                                _doCryptBlock: function (M, offset, keySchedule, SUB_MIX_02, SUB_MIX_12, SUB_MIX_22, SUB_MIX_32, SBOX2) {
                                    for (var nRounds = this._nRounds, s0 = M[offset] ^ keySchedule[0], s1 = M[offset + 1] ^ keySchedule[1], s2 = M[offset + 2] ^ keySchedule[2], s3 = M[offset + 3] ^ keySchedule[3], ksRow = 4, round = 1; round < nRounds; round++) {
                                        var t0 = SUB_MIX_02[s0 >>> 24] ^ SUB_MIX_12[s1 >>> 16 & 255] ^ SUB_MIX_22[s2 >>> 8 & 255] ^ SUB_MIX_32[s3 & 255] ^ keySchedule[ksRow++], t1 = SUB_MIX_02[s1 >>> 24] ^ SUB_MIX_12[s2 >>> 16 & 255] ^ SUB_MIX_22[s3 >>> 8 & 255] ^ SUB_MIX_32[s0 & 255] ^ keySchedule[ksRow++], t2 = SUB_MIX_02[s2 >>> 24] ^ SUB_MIX_12[s3 >>> 16 & 255] ^ SUB_MIX_22[s0 >>> 8 & 255] ^ SUB_MIX_32[s1 & 255] ^ keySchedule[ksRow++], t3 = SUB_MIX_02[s3 >>> 24] ^ SUB_MIX_12[s0 >>> 16 & 255] ^ SUB_MIX_22[s1 >>> 8 & 255] ^ SUB_MIX_32[s2 & 255] ^ keySchedule[ksRow++];
                                        s0 = t0, s1 = t1, s2 = t2, s3 = t3;
                                    }
                                    var t0 = (SBOX2[s0 >>> 24] << 24 | SBOX2[s1 >>> 16 & 255] << 16 | SBOX2[s2 >>> 8 & 255] << 8 | SBOX2[s3 & 255]) ^ keySchedule[ksRow++], t1 = (SBOX2[s1 >>> 24] << 24 | SBOX2[s2 >>> 16 & 255] << 16 | SBOX2[s3 >>> 8 & 255] << 8 | SBOX2[s0 & 255]) ^ keySchedule[ksRow++], t2 = (SBOX2[s2 >>> 24] << 24 | SBOX2[s3 >>> 16 & 255] << 16 | SBOX2[s0 >>> 8 & 255] << 8 | SBOX2[s1 & 255]) ^ keySchedule[ksRow++], t3 = (SBOX2[s3 >>> 24] << 24 | SBOX2[s0 >>> 16 & 255] << 16 | SBOX2[s1 >>> 8 & 255] << 8 | SBOX2[s2 & 255]) ^ keySchedule[ksRow++];
                                    M[offset] = t0, M[offset + 1] = t1, M[offset + 2] = t2, M[offset + 3] = t3;
                                },
                                keySize: 256 / 32
                            });
                            C.AES = BlockCipher._createHelper(AES);
                        }(), CryptoJS.AES;
                    });
                }
            });

            // entry.js
            var require_entry = __commonJS({
                "entry.js"(exports, module) {
                    var C = require_core();
                    require_enc_base64();
                    require_md5();
                    require_evpkdf();
                    require_cipher_core();
                    require_aes();
                    module.exports = C;
                }
            });
            return require_entry();
        })();
    }));
/*!
 * html-content-signature v2
 * ------------------------------------------------------------------
 * Deterministic canonical signature of an HTML body's *rendered content*,
 * for detecting tampering by comparing two signatures.
 *
 * Design goals (in priority order):
 *   1. HOST INDEPENDENCE - the default path is a pure string tokenizer, so
 *      New Outlook (Chromium/WebView2) and Classic Outlook (mshtml/IE11)
 *      produce byte-identical signatures. No DOMParser required.
 *   2. UNFORGEABLE ENCODING - tokens are JSON-encoded, so no text content
 *      can imitate a structural token (the old "|"/":" scheme could).
 *   3. NO BLIND SPOTS THAT CHANGE WHAT THE USER SEES OR CLICKS -
 *      link targets, srcset, CSS urls, style/script bodies are covered.
 *   4. NO FALSE POSITIVES on benign re-serialization - comments, inline
 *      wrapper churn, entity form, whitespace form, NBSP, zero-width junk.
 *
 * Usage:
 *   var sig = HtmlContentSignature.signature(html);        // canonical string
 *   HtmlContentSignature.equal(a, b);                      // boolean
 *   HtmlContentSignature.diff(a, b);                       // where they differ
 *   HtmlContentSignature.digest(html);                     // short, NON-crypto
 *
 * NOTE ON TRUST: this is an integrity *diff*, not a MAC. If the baseline
 * signature travels with the message or is stored client-side, an attacker
 * who can edit the HTML can also edit the baseline. Sign/HMAC the canonical
 * string server-side if you need authenticity, not just change detection.
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.HtmlContentSignature = factory();
})(
    // Classic Outlook's JSRuntime is not a clean browser-or-node global: resolve
    // through every known name, same trick as the patched CryptoJS UMD wrapper
    // that ships alongside this file in the classic bundle.
    (typeof self !== "undefined" && self) ||
    (typeof window !== "undefined" && window) ||
    (typeof globalThis !== "undefined" && globalThis) ||
    this,
    function () {
        "use strict";

        var VERSION = "hcs2";

        /* ---------------------------------------------------------------- tables */

        // Elements whose content is raw text, not markup.
        var RAW_TEXT = {
            script: 1, style: 1, title: 1, textarea: 1,
            xmp: 1, noscript: 1, noframes: 1, plaintext: 1
        };

        // Elements that force a visual break between text runs.
        var BLOCK = {
            address: 1, article: 1, aside: 1, blockquote: 1, body: 1, br: 1,
            caption: 1, center: 1, col: 1, colgroup: 1, dd: 1, details: 1, dialog: 1,
            dir: 1, div: 1, dl: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1,
            footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1,
            hgroup: 1, hr: 1, html: 1, legend: 1, li: 1, main: 1, menu: 1, nav: 1,
            ol: 1, optgroup: 1, option: 1, p: 1, pre: 1, section: 1, summary: 1,
            table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, ul: 1
        };

        // URL-bearing attributes, in FIXED order so emission is deterministic.
        var URL_ATTRS = [
            "src", "srcset", "poster", "background", "data",
            "xlink:href", "formaction", "action", "dynsrc", "lowsrc"
        ];

        var NAMED = {
            amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
            ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200C", zwj: "\u200D",
            lrm: "\u200E", rlm: "\u200F", shy: "\u00AD",
            ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019",
            sbquo: "\u201A", ldquo: "\u201C", rdquo: "\u201D", bdquo: "\u201E",
            dagger: "\u2020", Dagger: "\u2021", bull: "\u2022", hellip: "\u2026",
            permil: "\u2030", prime: "\u2032", Prime: "\u2033", lsaquo: "\u2039",
            rsaquo: "\u203A", oline: "\u203E", frasl: "\u2044", euro: "\u20AC",
            trade: "\u2122", copy: "\u00A9", reg: "\u00AE", deg: "\u00B0",
            plusmn: "\u00B1", middot: "\u00B7", laquo: "\u00AB", raquo: "\u00BB",
            times: "\u00D7", divide: "\u00F7", frac12: "\u00BD", frac14: "\u00BC",
            frac34: "\u00BE", pound: "\u00A3", yen: "\u00A5", cent: "\u00A2",
            curren: "\u00A4", sect: "\u00A7", para: "\u00B6", micro: "\u00B5",
            iexcl: "\u00A1", iquest: "\u00BF", brvbar: "\u00A6", uml: "\u00A8",
            not: "\u00AC", macr: "\u00AF", acute: "\u00B4", cedil: "\u00B8",
            sup1: "\u00B9", sup2: "\u00B2", sup3: "\u00B3", ordm: "\u00BA", ordf: "\u00AA",
            agrave: "\u00E0", aacute: "\u00E1", acirc: "\u00E2", atilde: "\u00E3",
            auml: "\u00E4", aring: "\u00E5", ccedil: "\u00E7", egrave: "\u00E8",
            eacute: "\u00E9", ecirc: "\u00EA", euml: "\u00EB", igrave: "\u00EC",
            iacute: "\u00ED", icirc: "\u00EE", iuml: "\u00EF", ntilde: "\u00F1",
            ograve: "\u00F2", oacute: "\u00F3", ocirc: "\u00F4", otilde: "\u00F5",
            ouml: "\u00F6", ugrave: "\u00F9", uacute: "\u00FA", ucirc: "\u00FB",
            uuml: "\u00FC", yacute: "\u00FD", szlig: "\u00DF",
            Agrave: "\u00C0", Aacute: "\u00C1", Auml: "\u00C4", Ccedil: "\u00C7",
            Egrave: "\u00C8", Eacute: "\u00C9", Ouml: "\u00D6", Uuml: "\u00DC",
            Ntilde: "\u00D1"
        };

        // Entities browsers decode even without a trailing semicolon.
        var NO_SEMI = {
            amp: 1, lt: 1, gt: 1, quot: 1, nbsp: 1, copy: 1, reg: 1, deg: 1, pound: 1,
            yen: 1, cent: 1, sect: 1, middot: 1, times: 1, divide: 1, not: 1, shy: 1,
            macr: 1, acute: 1, uml: 1, para: 1, micro: 1
        };

        // Invisible / formatting characters that cannot change what is rendered.
        var ZERO_WIDTH = /[\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\uFEFF]/g;
        // Everything HTML treats as collapsible whitespace, incl. NBSP + Unicode spaces.
        var WHITESPACE = /[\t\n\f\r \u000B\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

        var DEFAULTS = {
            links: true,        // capture <a href> / <area href> targets
            media: true,        // capture src / srcset / poster / background / ...
            css: true,          // capture <style> bodies and style="" url()s
            scriptBodies: true, // capture <script> bodies
            breaks: true,       // emit break tokens at block boundaries
            normalizeUnicode: true, // NFC, so composed vs decomposed compare equal
            lowercaseUrls: false,   // off: URL paths are case-sensitive
            // Collapse cid:/blob:/data: URLs to one placeholder. REQUIRED when
            // comparing against a live Outlook draft body: the host rewrites remote
            // <img src> to cid: attachment references as soon as the signature is
            // inserted, so a strict URL compare reports every desktop draft as tampered.
            // http(s) URLs stay strict - those are the ones worth guarding.
            hostRewrittenUrls: false
        };

        /* --------------------------------------------------------------- helpers */

        function options(o) {
            var out = {}, k;
            for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) out[k] = DEFAULTS[k];
            if (o) for (k in o) if (o.hasOwnProperty(k) && out.hasOwnProperty(k)) out[k] = o[k];
            return out;
        }

        function fromCodePoint(cp) {
            if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
            if (cp > 0xffff) {
                cp -= 0x10000;
                return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            }
            return String.fromCharCode(cp);
        }

        var ENT_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31})(;?)/g;

        function decodeEntities(str) {
            if (str.indexOf("&") === -1) return str;
            return str.replace(ENT_RE, function (m, body, semi) {
                if (body.charAt(0) === "#") {
                    var cp = body.charAt(1) === "x" || body.charAt(1) === "X"
                        ? parseInt(body.slice(2), 16)
                        : parseInt(body.slice(1), 10);
                    if (isNaN(cp)) return m;
                    return fromCodePoint(cp);
                }
                if (NAMED.hasOwnProperty(body) && (semi || NO_SEMI[body])) return NAMED[body];
                // Unknown entity: leave verbatim. Deterministic on every host.
                return m;
            });
        }

        function normalizeText(s, o) {
            s = s.replace(ZERO_WIDTH, "");
            if (o.normalizeUnicode && typeof s.normalize === "function") {
                try { s = s.normalize("NFC"); } catch (e) { /* older hosts */ }
            }
            return s.replace(WHITESPACE, " ");
        }

        // Browsers strip tabs/newlines/CRs from URLs and trim surrounding whitespace.
        function normalizeUrl(v, o) {
            if (v == null) return "";
            v = decodeEntities(String(v)).replace(/[\t\n\r]+/g, "").replace(ZERO_WIDTH, "");
            v = v.replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, "");
            if (o.hostRewrittenUrls && /^(?:cid|blob|data):/i.test(v)) return "@embedded";
            return o.lowercaseUrls ? v.toLowerCase() : v;
        }

        function normalizeSrcset(v, o) {
            // "a.png 1x,  b.png 2x" -> "a.png 1x,b.png 2x" (order preserved, ws collapsed)
            var parts = String(v == null ? "" : v).split(",");
            var res = [], i, p, sp, url, desc;
            for (i = 0; i < parts.length; i++) {
                p = decodeEntities(parts[i]).replace(WHITESPACE, " ").replace(/^ | $/g, "");
                if (!p) continue;
                sp = p.indexOf(" ");
                url = sp === -1 ? p : p.slice(0, sp);
                desc = sp === -1 ? "" : " " + p.slice(sp + 1);
                res.push(normalizeUrl(url, o) + desc);
            }
            return res.join(",");
        }

        var CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

        function cssUrls(css, o) {
            var found = [], m;
            CSS_URL_RE.lastIndex = 0;
            while ((m = CSS_URL_RE.exec(css)) !== null) {
                var u = normalizeUrl(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]), o);
                if (u) found.push(u);
                if (CSS_URL_RE.lastIndex === m.index) CSS_URL_RE.lastIndex++; // guard
            }
            return found;
        }

        /* ---------------------------------------------------------- token emitter */

        function Emitter(o) {
            this.o = o;
            this.tokens = [];
            this.buf = [];
            this.pendingSpace = false;
        }

        Emitter.prototype.flush = function () {
            if (this.buf.length) {
                this.tokens.push(["t", this.buf.join("")]);
                this.buf.length = 0;
            }
            this.pendingSpace = false;
        };

        Emitter.prototype.text = function (raw, alreadyDecoded) {
            if (!raw) return;
            var t = normalizeText(alreadyDecoded ? raw : decodeEntities(raw), this.o);
            if (!t) return;
            if (t === " ") { if (this.buf.length) this.pendingSpace = true; return; }
            var lead = t.charAt(0) === " ";
            var trail = t.charAt(t.length - 1) === " ";
            var core = t.replace(/^ +| +$/g, "");
            if (this.buf.length && (this.pendingSpace || lead)) this.buf.push(" ");
            this.buf.push(core);
            this.pendingSpace = trail;
        };

        Emitter.prototype.token = function (arr) {
            this.flush();
            this.tokens.push(arr);
        };

        Emitter.prototype.brk = function () {
            if (!this.o.breaks) { if (this.buf.length) this.pendingSpace = true; return; }
            this.flush();
            var last = this.tokens[this.tokens.length - 1];
            if (!this.tokens.length) return;                 // no leading break
            if (last && last.length === 1 && last[0] === "b") return; // no doubles
            this.tokens.push(["b"]);
        };

        // Shared per-element handling for both the tokenizer and the DOM walker.
        Emitter.prototype.element = function (tag, getAttr) {
            var o = this.o, i, a, v;

            if (BLOCK[tag]) this.brk();

            if (o.media) {
                for (i = 0; i < URL_ATTRS.length; i++) {
                    a = URL_ATTRS[i];
                    v = getAttr(a);
                    if (v == null) continue;
                    this.token(["u", tag, a, a === "srcset" ? normalizeSrcset(v, o) : normalizeUrl(v, o)]);
                }
            }

            if (o.links && (tag === "a" || tag === "area" || tag === "link")) {
                v = getAttr("href");
                if (v != null) this.token(["h", tag, normalizeUrl(v, o)]);
            }

            // <img> must always be visible in the signature, even with no src,
            // because its mere presence is rendered content.
            if (tag === "img" || tag === "image" || tag === "input" || tag === "object" ||
                tag === "embed" || tag === "iframe" || tag === "video" || tag === "audio" ||
                tag === "svg" || tag === "canvas") {
                this.token(["e", tag]);
                if (tag === "input") {
                    v = getAttr("type");
                    if (v != null) this.token(["a", "type", normalizeText(decodeEntities(String(v)), o)]);
                    v = getAttr("value");
                    if (v != null) this.token(["a", "value", normalizeText(decodeEntities(String(v)), o)]);
                }
            }

            if (o.css) {
                v = getAttr("style");
                if (v != null) {
                    var urls = cssUrls(decodeEntities(String(v)), o);
                    for (i = 0; i < urls.length; i++) this.token(["c", urls[i]]);
                }
            }
        };

        Emitter.prototype.rawBody = function (tag, body) {
            var o = this.o, i, urls;
            if (tag === "style") {
                if (!o.css) return;
                body = normalizeText(decodeEntities(body), o).replace(/^ +| +$/g, "");
                this.token(["s", "style", body]);
                return;
            }
            if (tag === "script") {
                if (!o.scriptBodies) return;
                body = body.replace(WHITESPACE, " ").replace(/^ +| +$/g, "");
                this.token(["s", "script", body]);
                return;
            }
            if (tag === "textarea" || tag === "title") {
                this.token(["s", tag, normalizeText(decodeEntities(body), o).replace(/^ +| +$/g, "")]);
                return;
            }
            // noscript / noframes / xmp / plaintext: treat body as visible text
            this.text(body);
        };

        Emitter.prototype.finish = function () {
            this.flush();
            var t = this.tokens;
            while (t.length && t[t.length - 1].length === 1 && t[t.length - 1][0] === "b") t.pop();
            return t;
        };

        /* --------------------------------------------------- tokenizer (default) */

        function attrGetter(attrs) {
            return function (name) {
                return attrs.hasOwnProperty(name) ? attrs[name] : null;
            };
        }

        var ATTR_RE = /([^\s=\/>"'][^\s=\/>]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

        function parseAttrs(src) {
            var attrs = {}, m, name;
            ATTR_RE.lastIndex = 0;
            while ((m = ATTR_RE.exec(src)) !== null) {
                if (ATTR_RE.lastIndex === m.index) { ATTR_RE.lastIndex++; continue; }
                name = m[1].toLowerCase();
                if (name === "/" || !name) continue;
                var val = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ""));
                // First occurrence wins, matching the HTML parser.
                if (!attrs.hasOwnProperty(name)) attrs[name] = val;
            }
            return attrs;
        }

        function tokenize(html, o) {
            var s = html == null ? "" : String(html);
            var n = s.length, i = 0, em = new Emitter(o), guard = 0;

            while (i < n) {
                if (++guard > n * 4 + 16) break; // paranoia: never loop forever

                var lt = s.indexOf("<", i);
                if (lt < 0) { em.text(s.slice(i)); break; }
                if (lt > i) em.text(s.slice(i, lt));

                var next = s.charAt(lt + 1);

                // Comments (incl. IE conditional comments) - skipped on every host.
                if (s.substr(lt, 4) === "<!--") {
                    var endC = s.indexOf("-->", lt + 4);
                    if (endC < 0) { i = n; break; }
                    i = endC + 3;
                    continue;
                }
                // Doctype, CDATA, processing instructions, bogus comments.
                if (next === "!" || next === "?") {
                    var endB = s.indexOf(">", lt + 2);
                    i = endB < 0 ? n : endB + 1;
                    continue;
                }

                var isEnd = next === "/";
                var nameStart = lt + (isEnd ? 2 : 1);
                var ch = s.charAt(nameStart);
                if (!/[a-zA-Z]/.test(ch)) {           // a literal "<" in text
                    em.text("<");
                    i = lt + 1;
                    continue;
                }

                var p = nameStart;
                while (p < n && /[^\s\/>]/.test(s.charAt(p))) p++;
                var tag = s.slice(nameStart, p).toLowerCase();

                // Find the tag's ">" while respecting quoted attribute values.
                var q = p, quote = "";
                while (q < n) {
                    var c = s.charAt(q);
                    if (quote) { if (c === quote) quote = ""; }
                    else if (c === '"' || c === "'") quote = c;
                    else if (c === ">") break;
                    q++;
                }
                var attrSrc = s.slice(p, q);
                i = (q < n ? q + 1 : n);

                if (isEnd) {
                    if (BLOCK[tag]) em.brk();
                    if (o.links && tag === "a") em.token(["/h"]);
                    continue;
                }

                var attrs = parseAttrs(attrSrc);
                em.element(tag, attrGetter(attrs));

                if (RAW_TEXT[tag]) {
                    if (tag === "plaintext") { em.rawBody(tag, s.slice(i)); i = n; continue; }
                    var close = -1, from = i;
                    // case-insensitive search for "</tag"
                    var lower = s.toLowerCase(), needle = "</" + tag;
                    close = lower.indexOf(needle, from);
                    if (close < 0) { em.rawBody(tag, s.slice(from)); i = n; continue; }
                    em.rawBody(tag, s.slice(from, close));
                    i = close; // end tag consumed on the next iteration
                }
            }

            return em.finish();
        }

        /* ------------------------------------------------- DOM path (diagnostic) */

        var TEXT_NODE = 3, ELEMENT_NODE = 1;

        function domParserSupportsHtml() {
            try {
                if (typeof DOMParser === "undefined") return false;
                var d = new DOMParser().parseFromString("<i>x</i>", "text/html");
                return !!(d && d.body && d.body.textContent === "x");
            } catch (e) { return false; }
        }

        function parseToBody(html) {
            var str = html == null ? "" : String(html);
            if (domParserSupportsHtml()) {
                var d = new DOMParser().parseFromString(str, "text/html");
                if (d && d.body) return d.body;
            }
            if (typeof document !== "undefined" && document.implementation &&
                document.implementation.createHTMLDocument) {
                var doc = document.implementation.createHTMLDocument("");
                // Neutralise loading attributes so an inert parse cannot hit the network,
                // then read them back from their data-* twins.
                doc.body.innerHTML = str.replace(
                    /\s(src|srcset|background|poster|lowsrc|dynsrc)\s*=/gi,
                    " data-hcs-$1="
                );
                return doc.body;
            }
            return null;
        }

        function domAttrGetter(el) {
            return function (name) {
                if (el.hasAttribute && el.hasAttribute(name)) return el.getAttribute(name);
                if (el.hasAttribute && el.hasAttribute("data-hcs-" + name)) {
                    return el.getAttribute("data-hcs-" + name);
                }
                return null;
            };
        }

        function tokenizeDom(html, o) {
            var body = parseToBody(html);
            var em = new Emitter(o);
            if (!body) return null;

            var stack = [{ node: body, i: 0, entered: false }];
            while (stack.length) {
                var top = stack[stack.length - 1];
                var node = top.node;

                if (!top.entered) {
                    top.entered = true;
                    if (node !== body && node.nodeType === ELEMENT_NODE) {
                        var tag = String(node.tagName || "").toLowerCase();
                        em.element(tag, domAttrGetter(node));
                        if (RAW_TEXT[tag]) {
                            em.rawBody(tag, node.textContent || "");
                            stack.pop();
                            continue;
                        }
                    }
                }

                var kids = node.childNodes;
                if (kids && top.i < kids.length) {
                    var child = kids[top.i++];
                    if (child.nodeType === TEXT_NODE) em.text(child.nodeValue || "", true);
                    else if (child.nodeType === ELEMENT_NODE) stack.push({ node: child, i: 0, entered: false });
                    continue;
                }

                if (node !== body && node.nodeType === ELEMENT_NODE) {
                    var t2 = String(node.tagName || "").toLowerCase();
                    if (BLOCK[t2]) em.brk();
                    if (o.links && t2 === "a") em.token(["/h"]);
                }
                stack.pop();
            }
            return em.finish();
        }

        /* ------------------------------------------------- marked region extraction
      
           Locating "the signature" inside a draft body needs an anchor, because
           setSignatureAsync does NOT always put the block at the end (on a reply it
           sits above the quoted original). Wrap what you write in a marked element
           and pull it back out by that attribute.
      
           Void elements never open a depth level; raw-text elements are skipped so a
           marker mentioned inside <style> or a comment cannot be mistaken for one.
        ------------------------------------------------------------------------- */

        var VOID = {
            area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
            link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
        };

        function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
        function isTagNameEnd(c) {
            return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 47 || c === 62;
        }

        /**
         * Every element carrying `attr`, with its inner HTML and the attribute value.
         *
         * PERFORMANCE NOTE: this is one flat loop over char codes on purpose. The
         * first version walked tags through a callback and allocated a descriptor
         * object per tag; V8 ran it at ~14ms for three calls and then, once the
         * function was optimised, at ~575ms on the SAME 140KB input - a 40x deopt
         * cliff that would land squarely inside the send budget. Do not reintroduce
         * a per-tag callback or per-tag object here.
         *
         * @returns {Array<{value:string, inner:string, tag:string, start:number, end:number}>}
         *   start/end bracket the whole element, so a caller can compare against a
         *   quote boundary and discard copies sitting in the quoted thread.
         */
        function extractMarkedRegions(html, attr) {
            var s = String(html == null ? "" : html);
            var a = String(attr).toLowerCase();
            var found = [];
            if (!s || s.indexOf("<") === -1) return found;

            var lower = s.toLowerCase();
            if (lower.indexOf(a) === -1) return found;   // no marker anywhere: done

            var n = s.length, i = 0;
            var openTag = "", depth = 0, innerStart = 0, openValue = "", openStart = 0;

            while (i < n) {
                var lt = s.indexOf("<", i);
                if (lt < 0) break;

                // <!-- comment -->  (also swallows IE conditional comment blocks)
                if (s.charCodeAt(lt + 1) === 33 && s.charCodeAt(lt + 2) === 45 && s.charCodeAt(lt + 3) === 45) {
                    var ec = s.indexOf("-->", lt + 4);
                    i = ec < 0 ? n : ec + 3;
                    continue;
                }
                var nc = s.charCodeAt(lt + 1);
                if (nc === 33 || nc === 63) {              // doctype / PI / bogus comment
                    var eb = s.indexOf(">", lt + 2);
                    i = eb < 0 ? n : eb + 1;
                    continue;
                }

                var isEnd = nc === 47;
                var ns = lt + (isEnd ? 2 : 1);
                if (!isAlpha(s.charCodeAt(ns))) { i = lt + 1; continue; }

                var p = ns;
                while (p < n && !isTagNameEnd(s.charCodeAt(p))) p++;
                var tag = lower.slice(ns, p);

                var q = p, quote = 0;
                while (q < n) {
                    var c = s.charCodeAt(q);
                    if (quote) { if (c === quote) quote = 0; }
                    else if (c === 34 || c === 39) quote = c;
                    else if (c === 62) break;
                    q++;
                }
                var afterTag = (q < n ? q + 1 : n);
                // "/>" or a void element never opens a depth level.
                var selfClosing = !!VOID[tag] || (function () {
                    var k = q - 1;
                    while (k > p && isTagNameEnd(s.charCodeAt(k)) && s.charCodeAt(k) !== 47) k--;
                    return s.charCodeAt(k) === 47;
                })();

                if (depth > 0) {
                    if (tag === openTag) {
                        if (isEnd) {
                            if (--depth === 0) {
                                found.push({
                                    value: openValue, tag: openTag, inner: s.slice(innerStart, lt),
                                    start: openStart, end: afterTag
                                });
                            }
                        } else if (!selfClosing) depth++;
                    }
                } else if (!isEnd && !selfClosing && q - p > a.length) {
                    // Search WITHIN this tag only. `lower.indexOf(a, p)` would scan to the
                    // end of the document for every tag that lacks the marker - O(n^2), and
                    // ~155ms on a 140KB reply thread.
                    var attrSrc = lower.slice(p, q);
                    var attrs = attrSrc.indexOf(a) === -1 ? null : parseAttrs(s.slice(p, q));
                    if (attrs && attrs.hasOwnProperty(a)) {
                        openTag = tag;
                        depth = 1;
                        innerStart = afterTag;
                        openStart = lt;
                        openValue = decodeEntities(attrs[a] || "");
                    }
                }

                i = afterTag;
                // Never look for markers inside <style>/<script>/<textarea>/<title>.
                if (!isEnd && RAW_TEXT[tag]) {
                    var close = lower.indexOf("</" + tag, i);
                    i = close < 0 ? n : close;
                }
            }

            // Unclosed marker (truncated body, or the host mangled the wrapper): take
            // everything after it rather than reporting nothing.
            if (depth > 0) {
                found.push({
                    value: openValue, tag: openTag, inner: s.slice(innerStart),
                    start: openStart, end: s.length
                });
            }
            return found;
        }

        /* ------------------------------------------------- draft / quote splitting
      
           A reply or forward body is NOT just the signature and the user's text: it
           also carries the quoted thread, which very often contains an intact copy of
           the same signature (any earlier mail in the thread that we signed). Search
           the whole body and that copy answers "is the signature intact?" on behalf
           of the live one — so an edited or deleted live signature reads as
           identical. Verification must be scoped to the live part.
      
           These markers are the separators Outlook and other clients put in front of
           the quoted section. They are deliberately high-signal: the EARLIEST match
           wins, so a false positive would truncate too early, report the signature as
           absent, and cause a rewrite - the safe direction. A bare <hr> is not in the
           list precisely because signatures contain them.
        ------------------------------------------------------------------------- */

        var QUOTE_MARKERS = [
            "appendonsend",                                 // OWA / New Outlook anchor
            "divrplyfwdmsg",                                // Outlook desktop (and x_ prefixed)
            "mail-editor-reference-message-container",       // OWA
            "-----original message-----",                    // Outlook plain separator
            "-------- original message --------",            // mobile / other clients
            "id=\"stopspelling\"", "id='stopspelling'",      // Outlook Windows separator
            "blockquote type=\"cite\"", "blockquote type='cite'", // Mac Outlook, Apple Mail
            "gmail_quote",                                   // Gmail
            "yahoo_quoted",                                  // Yahoo
            "ms-outlook-mobile-reference-message",            // Outlook mobile
            "border-top:solid #e1e1e1 1.0pt"                 // Word's reply separator
        ];

        /**
         * Split a draft body into the live compose area and the quoted thread.
         * @returns {{live:string, quoted:string, boundary:number}}
         *   boundary === html.length when no quoted section was found.
         */
        function splitDraftAtQuote(html) {
            var s = String(html == null ? "" : html);
            var lower = s.toLowerCase();
            var at = -1;
            for (var i = 0; i < QUOTE_MARKERS.length; i++) {
                var hit = lower.indexOf(QUOTE_MARKERS[i]);
                if (hit !== -1 && (at === -1 || hit < at)) at = hit;
            }
            if (at === -1) return { live: s, quoted: "", boundary: s.length };
            // Rewind to the start of the tag the marker sits in, so a marked signature
            // ending right before the separator is not clipped mid-element.
            var lt = s.lastIndexOf("<", at);
            if (lt !== -1) at = lt;
            return { live: s.slice(0, at), quoted: s.slice(at), boundary: at };
        }

        // Ready-made option sets. `body` is the one to use against a draft body.
        var PROFILES = {
            // Byte-for-byte content equality. For comparing two stored copies.
            strict: {},
            // For comparing a stored signature against what is in an Outlook draft.
            // CSS and script bodies are excluded because the Word and OWA editors
            // rewrite style blocks and inline CSS wholesale - keeping them guarantees a
            // mismatch on every desktop draft. What remains is what tampering has to
            // touch to be harmful: visible text, link targets, image identity, order.
            body: { css: false, scriptBodies: false, hostRewrittenUrls: true }
        };

        function keyOf(tok) { return JSON.stringify(tok); }

        /**
         * Token equality with ONE asymmetric allowance: when hostRewrittenUrls is on,
         * "@embedded" in the URL slot of a ["u", tag, attr, url] token matches any
         * URL on the other side. The cached copy says
         * src="https://cdn.example/logo.png"; the draft says src="cid:image001.png"
         * because Outlook attached and rewrote it. Both describe the same image.
         *
         * KNOWN LIMIT: this means an attacker who replaces the logo with ANOTHER
         * cid: attachment is not caught by URL. Image count, position, and every
         * text and href token are still compared strictly, which is what makes a
         * misleading signature hard to build.
         */
        function tokEq(x, y, wild) {
            if (x.length !== y.length) return false;
            for (var i = 0; i < x.length; i++) {
                if (x[i] === y[i]) continue;
                if (wild && x[0] === "u" && i === 3 && (x[3] === "@embedded" || y[3] === "@embedded")) continue;
                return false;
            }
            return true;
        }

        function runsEqual(a, b, wild) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) if (!tokEq(a[i], b[i], wild)) return false;
            return true;
        }

        function stripEdgeBreaks(toks) {
            var a = 0, b = toks.length;
            while (a < b && toks[a].length === 1 && toks[a][0] === "b") a++;
            while (b > a && toks[b - 1].length === 1 && toks[b - 1][0] === "b") b--;
            return toks.slice(a, b);
        }

        // Index of the first contiguous occurrence of `needle` in `hay`, or -1.
        // Exact string-key pass first (fast); only retried with the URL wildcard if
        // that misses and the caller asked for host tolerance.
        function indexOfTokenRun(hay, needle, wild) {
            if (!needle.length) return -1;
            var hk = hay.map(keyOf), nk = needle.map(keyOf);
            var limit = hk.length - nk.length, i, j, ok;
            for (i = 0; i <= limit; i++) {
                ok = true;
                for (j = 0; j < nk.length; j++) if (hk[i + j] !== nk[j]) { ok = false; break; }
                if (ok) return i;
            }
            if (!wild) return -1;
            for (i = 0; i <= limit; i++) {
                ok = true;
                for (j = 0; j < needle.length; j++) if (!tokEq(hay[i + j], needle[j], true)) { ok = false; break; }
                if (ok) return i;
            }
            return -1;
        }

        // Fraction of the expected tokens present anywhere in the body (multiset).
        // Diagnostic only: it separates "edited" from "not there at all".
        function overlap(expected, actual) {
            var want = stripEdgeBreaks(expected).filter(function (t) { return t[0] !== "b"; });
            if (!want.length) return 1;
            var bag = {}, i, k;
            for (i = 0; i < actual.length; i++) {
                k = keyOf(actual[i]);
                bag[k] = (bag[k] || 0) + 1;
            }
            var hit = 0;
            for (i = 0; i < want.length; i++) {
                k = keyOf(want[i]);
                if (bag[k] > 0) { bag[k]--; hit++; }
            }
            return hit / want.length;
        }

        /**
         * Is `expectedHtml` present, unmodified, inside `containerHtml`?
         *
         * @returns {{verdict:"identical"|"modified"|"absent", at:number, overlap:number}}
         *   identical - found as an intact contiguous run
         *   modified  - much of it is there but not intact
         *   absent    - not meaningfully there at all
         */
        function verifyRegion(expectedHtml, containerHtml, o) {
            var opt = options(o);
            var exp = stripEdgeBreaks(tokenize(expectedHtml, opt));
            var act = tokenize(containerHtml, opt);
            if (!exp.length) return { verdict: "absent", at: -1, overlap: 0 };
            var at = indexOfTokenRun(act, exp, opt.hostRewrittenUrls);
            if (at >= 0) return { verdict: "identical", at: at, overlap: 1 };
            var ov = overlap(exp, act);
            return { verdict: ov >= 0.5 ? "modified" : "absent", at: -1, overlap: ov };
        }

        /** Direct equality of two HTML fragments under a profile. */
        function verifyExact(expectedHtml, actualHtml, o) {
            var opt = options(o);
            var exp = stripEdgeBreaks(tokenize(expectedHtml, opt));
            var act = stripEdgeBreaks(tokenize(actualHtml, opt));
            if (runsEqual(exp, act, opt.hostRewrittenUrls)) return { verdict: "identical", at: 0, overlap: 1 };
            var ov = overlap(exp, act);
            return { verdict: ov >= 0.5 ? "modified" : "absent", at: -1, overlap: ov };
        }

        /**
         * THE POLICY BOTH BUILDS SHARE. Is our signature still intact on this DRAFT?
         *
         * Everything here exists because a draft is not a fragment. On a reply or
         * forward it contains the quoted thread, and that thread routinely holds an
         * intact copy of the very signature being checked. So:
         *
         *   1. The body is split at the quoted-thread boundary; only the LIVE part is
         *      ever searched. A pristine copy sitting in the quote can no longer
         *      answer for an edited live one.
         *   2. Marked regions inside the quote are discarded rather than counted as
         *      duplicates - otherwise every reply in a thread we have signed before
         *      reports "duplicate" and gets rewritten for nothing.
         *   3. If the live part has no copy at all, the verdict is absent/modified and
         *      the caller rewrites, even when the quote holds a perfect copy. That is
         *      the point: what matters is what the recipient will read at the top.
         *
         * DELIBERATE COST: with Outlook configured to place the signature BELOW the
         * quoted text, the live block falls outside the live slice, so the verdict is
         * always "absent" and every send rewrites. That is exactly the pre-
         * verification behaviour, and it is preferred over the alternative - trusting
         * a trailing marked block, which on a reply-to-our-own-mail is indistinguish-
         * able from the oldest quoted signature at the bottom of the thread.
         *
         * @param {string} expectedHtml  the signature as resolved from cache
         * @param {string} bodyHtml      the whole draft body
         * @param {object} o             { markAttr, sigId, ...profile options }
         * @returns {{verdict:string, reason:string, scope:string, quotedCopy:boolean}}
         *   verdict: identical | modified | absent | duplicate | id-changed
         */
        function verifyInDraft(expectedHtml, bodyHtml, o) {
            var opt = options(o);
            var attr = (o && o.markAttr) || "data-cb-sig";
            var sigId = o && o.sigId != null ? String(o.sigId) : null;

            var split = splitDraftAtQuote(bodyHtml);
            var hasQuote = split.boundary < String(bodyHtml == null ? "" : bodyHtml).length;
            var scope = hasQuote ? "live-of-reply" : "whole-body";

            var all = extractMarkedRegions(bodyHtml, attr);
            var live = [], quoted = 0;
            for (var i = 0; i < all.length; i++) {
                if (all[i].start < split.boundary) live.push(all[i]);
                else quoted++;
            }

            // Is there an intact copy in the quoted thread? Diagnostic only - it never
            // changes the verdict, but it is the single most useful fact in a log when
            // someone asks why a reply was rewritten. Computed LAZILY: tokenising a long
            // quoted thread costs ~12ms on a 137KB reply, and it is pointless when the
            // live block already verified clean.
            var quotedCopy = null;
            function describe(extra) {
                if (quotedCopy === null) {
                    quotedCopy = !!split.quoted &&
                        verifyRegion(expectedHtml, split.quoted, opt).verdict === "identical";
                }
                return extra +
                    (quoted ? ", " + quoted + " marked copy/copies in the quote" : "") +
                    (quotedCopy ? ", intact copy in the quote (ignored)" : "");
            }

            if (live.length > 1) {
                return {
                    verdict: "duplicate", scope: scope, quotedCopy: quotedCopy,
                    reason: describe(live.length + " signature blocks in the live area")
                };
            }

            if (live.length === 1) {
                if (sigId !== null && String(live[0].value) !== sigId) {
                    return {
                        verdict: "id-changed", scope: scope, quotedCopy: quotedCopy,
                        reason: describe("live block has id=" + live[0].value + ", target=" + sigId)
                    };
                }
                var r = verifyExact(expectedHtml, live[0].inner, opt);
                // Clean live block: skip the quoted-thread scan entirely.
                if (r.verdict === "identical") {
                    return {
                        verdict: "identical", scope: scope, quotedCopy: false,
                        reason: "marked live block, overlap=1.00" +
                            (quoted ? ", " + quoted + " marked copy/copies in the quote (ignored)" : "")
                    };
                }
                return {
                    verdict: r.verdict, scope: scope, quotedCopy: quotedCopy,
                    reason: describe("marked live block, overlap=" + r.overlap.toFixed(2))
                };
            }

            // No marked block in the live area: a pre-wrapper draft, a stripped
            // attribute, or a signature that was never written here. Search the LIVE
            // slice only - never the quote.
            var r2 = verifyRegion(expectedHtml, split.live, opt);
            if (r2.verdict === "identical") {
                return {
                    verdict: "identical", scope: scope, quotedCopy: false,
                    reason: "unmarked live area, overlap=1.00"
                };
            }
            return {
                verdict: r2.verdict, scope: scope, quotedCopy: quotedCopy,
                reason: describe("unmarked live area, overlap=" + r2.overlap.toFixed(2))
            };
        }

        /* -------------------------------------------------------------- public API */

        function tokensOf(html, o) { return tokenize(html, options(o)); }

        function serialize(tokens) {
            return VERSION + ":" + tokens.length + ":" + JSON.stringify(tokens);
        }

        function signature(html, o) { return serialize(tokensOf(html, o)); }

        function signatureFromDom(html, o) {
            var t = tokenizeDom(html, options(o));
            return t ? serialize(t) : null;
        }

        function equal(a, b, o) {
            var sa = signature(a, o), sb = signature(b, o);
            return sa.length === sb.length && sa === sb;
        }

        function diff(a, b, o) {
            var ta = tokensOf(a, o), tb = tokensOf(b, o);
            var n = Math.max(ta.length, tb.length);
            for (var i = 0; i < n; i++) {
                var x = ta[i] ? JSON.stringify(ta[i]) : "(missing)";
                var y = tb[i] ? JSON.stringify(tb[i]) : "(missing)";
                if (x !== y) return { equal: false, index: i, left: x, right: y };
            }
            return { equal: true, index: -1, left: null, right: null };
        }

        // FNV-1a 32-bit + length. Short, stable, NOT cryptographic - do not use it
        // as the sole tamper check against a motivated attacker.
        function digest(html, o) {
            var s = signature(html, o), h = 0x811c9dc5;
            for (var i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
            }
            return ("0000000" + h.toString(16)).slice(-8) + "-" + s.length.toString(36);
        }

        return {
            VERSION: VERSION,
            DEFAULTS: DEFAULTS,
            PROFILES: PROFILES,
            extractMarkedRegions: extractMarkedRegions,
            splitDraftAtQuote: splitDraftAtQuote,
            verifyInDraft: verifyInDraft,
            verifyRegion: verifyRegion,
            verifyExact: verifyExact,
            indexOfTokenRun: indexOfTokenRun,
            signature: signature,
            signatureFromDom: signatureFromDom,
            tokens: tokensOf,
            equal: equal,
            diff: diff,
            digest: digest,
            domParserSupportsHtml: domParserSupportsHtml,
            _internals: { decodeEntities: decodeEntities, normalizeUrl: normalizeUrl }
        };
    });


// =============================================================================
//  CardByte Outlook Add-in — event-handler-classic.js (v6.0.0)
//  Target: Classic Outlook for Windows, JSRuntime (<Override type="javascript">)
//
//  This file is the LAST section of a three-part bundle:
//    1. CryptoJS (trimmed: AES-CBC / PKCS7 / Base64 only)  — crypto.subtle is
//       not available in the classic JSRuntime.
//    2. html-content-signature (HCS)                       — send-time verify.
//    3. this handler.
//  Only the single file named by v11.JSRuntime.Url is loaded; there is no
//  <script> tag and no import here.
//
//  INJECTION SEQUENCE
//    Phase 0  Manual override (taskpane pin) — wins outright.
//    Phase 1  DEFAULT signature, from cache if fresh, else network, else the
//             stale offline copy. Runs only on a draft nothing has decided yet,
//             and never at send.
//    Phase 2  RULES. Evaluate against To+Cc and compose type; write the winner
//             ONLY if the draft does not already carry it (verified by reading
//             the body, not by trusting a record).
//    Phase 3  event.completed(), then (compose only) prefetch rule signatures.
//
//  ─── v6.0.0 — WHY THE SEND WAS BEING BLOCKED, AND WHAT ELSE WAS WRONG ───────
//
//  1. THE GUARD BLOCKED THE SEND. makeGuardedEvent's timeout called
//     event.completed() with NO options. On OnMessageSend that is
//     allowEvent:false, which is exactly the dialog in the field report:
//     "CardByte Signature Manager is preventing this email from being sent"
//     with only a Don't Send button. The guard also fired routinely, because
//     the send path had a 6 s body read, two 5 s XHR attempts and a network
//     prefetch inside a 5 s budget. Now: the guard carries the handler's
//     default completion options; every OnMessageSend completion in this file
//     is {allowEvent:true}; and send mode shrinks every ceiling
//     (SEND_* constants) so the pipeline finishes well inside the budget.
//
//  2. THREE CONFIG KEYS WERE NEVER DECLARED. CONFIG.DEFAULT_ID, P_ACTIVE_SIG and
//     P_SIG_DIGEST were read but not defined: a pinned "default" was fetched as
//     /rules-config/get/default (404 → "signature unavailable"), and the item
//     properties the taskpane reads were written under the key "undefined".
//
//  3. BASE_URL WAS NOT IN THE MANIFEST'S AppDomains. The classic runtime only
//     lets XHR reach listed domains, so "ns-enterprise" returned status 0 on
//     every call and the add-in fell back to "Signature not available".
//     Now matches the manifest and the WebView build. If ns-enterprise IS the
//     intended host, add it to <AppDomains> AND change it here — both.
//
//  4. AN ERROR BAR FLASHED ON EVERY COMPOSE. Phase 1 opened by raising the
//     "Signature not available" errorMessage before doing anything. Progress
//     is informational; errors are raised only when the outcome is known.
//
//  5. THE CACHE WAS REFRESHED ON EVERY HIT, which made the 5-minute TTL
//     meaningless (and issued a network call on every compose). Freshness is
//     now bounded by CACHE_TTL_MS alone; a stale copy is served only when the
//     network cannot answer, and only within STALE_FALLBACK_MS.
//
//  6. A FAILED RECIPIENT READ WAS TREATED AS "NO RECIPIENTS". That resolved to
//     the default and, at send, replaced a correct rule signature. Reads are
//     three-valued now: null (unreadable → keep what was decided), [] (none →
//     default), [...] (evaluate).
//
//  7. NO NETWORK AT SEND UNLESS THE CACHE CANNOT ANSWER. Prefetch is compose
//     only; XHR at send is one attempt with a short timeout; a stale ruleset
//     or signature is preferred to a fetch.
//
//  Carried forward unchanged: per-account storage namespacing (v5), sender from
//  item.from (v5), verify-before-write with the marker-free fallback for Word's
//  attribute stripping, redundant-write suppression, the plan-expiry latch.
// =============================================================================

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
    VERSION: "classic-v6.0.0",

    AES_KEY_B64: "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=",
    AES_IV_B64: "3YapeNfJDung7TXxeKXn4g==",

    // MUST be listed in the manifest <AppDomains>. See v6 note (3).
    BASE_URL: "https://ns-enterprise.cardbyte.ai/email-signature",

    // The id standing for "the user's default (non-rule) signature". Shared
    // with the taskpane and the WebView build.
    DEFAULT_ID: "default",

    // Item custom properties (the cross-runtime channel shared with the pane).
    P_ACTIVE_SIG: "cardbyte_active_sig_id",
    P_SIG_DIGEST: "cardbyte_sig_digest",
    MANUAL_OVERRIDE_PROP: "cardbyte_manual_sig_id",

    // ── Network ──
    XHR_TIMEOUT_MS: 5000,
    XHR_MAX_ATTEMPTS: 2,
    XHR_RETRY_DELAY_MS: 600,
    XHR_LOG_BODY_CHARS: 400,
    // Send mode: one attempt, short. The send budget cannot absorb a retry.
    SEND_XHR_TIMEOUT_MS: 2500,
    SEND_XHR_MAX_ATTEMPTS: 1,

    // ── Handler budgets ──
    // Compose: the platform allows minutes; a long guard is a safety net only.
    COMPOSE_HANDLER_TIMEOUT_MS: 45000,
    // Send: the pipeline must complete with allowEvent:true well before the
    // host loses patience. Everything on the send path is bounded so the whole
    // thing fits inside this with headroom.
    SEND_HANDLER_TIMEOUT_MS: 4500,
    GUARD_INJECT_GRACE_MS: 3000,

    // Compose item resolution
    ITEM_RETRY_ATTEMPTS: 6,
    ITEM_RETRY_DELAY_MS: 250,
    SEND_ITEM_RETRY_ATTEMPTS: 2,

    // Ceiling for one Office.js callback on the critical path
    ASYNC_STEP_TIMEOUT_MS: 3000,
    SEND_ASYNC_STEP_TIMEOUT_MS: 1500,
    BODY_READ_TIMEOUT_MS: 6000,
    SEND_BODY_READ_TIMEOUT_MS: 2000,

    // ── Cache ──
    // Storage key stems; every key is suffixed ":<account>" by K.*.
    CACHE_KEY: "cardbyte_sig_html",           // default signature
    RULES_CACHE_KEY: "cardbyte_rules",
    SIG_BY_ID_CACHE_KEY: "cardbyte_sig_by_id", // { [id]: { html, ts } }
    LAST_APPLIED_KEY: "cardbyte_last_applied",

    // ONE freshness window for everything cached: default signature, rules and
    // per-id signatures are all refetched once older than this.
    CACHE_TTL_MS: 5 * 60 * 1000,
    // How long an EXPIRED copy is still usable as the offline/failure fallback.
    // Eviction, not freshness: it is only read when the network cannot answer.
    STALE_FALLBACK_MS: 12 * 60 * 60 * 1000,
    LAST_APPLIED_TTL_MS: 30 * 60 * 1000,

    // Suppress an identical re-write inside this window (recipient storms).
    REDUNDANT_WRITE_WINDOW_MS: 1500,

    // ── Rules ──
    // With no recipients at all the DEFAULT applies; rules are not consulted.
    EMPTY_RECIPIENTS_MEANS_DEFAULT: true,
    // When no forward-specific rule exists, let reply rules cover forwards.
    TREAT_FORWARD_AS_REPLY: true,

    // ── Tamper detection ──
    VERIFY_BEFORE_WRITE: true,
    SIG_MARK_ATTR: "data-cb-sig",

    // ── Notifications ──
    NOTIF_KEY: "cardbyte_sig_status",
    NOTIF_ICON: "v11.icon16",          // must be a <bt:Image> id in the V1_1 manifest
    NOTIFY_CLEAR_MS: 3000,
    MSG_LOADING: "Applying your signature...",
    MSG_APPLIED: "Signature applied",
    MSG_UNAVAILABLE: "Signature not available. Please contact Admin.",
    MSG_WRITE_FAILED: "Signature could not be applied. Please contact Admin.",

    // ── Plan expiry (HTTP 412 + PlanExpiredException) ──
    HTTP_PLAN_EXPIRED: 412,
    PLAN_EXPIRED_MSG: "Your subscription plan has expired. Please contact your Admin.",
    CLEAR_CACHE_ON_PLAN_EXPIRED: true,

    // Prepend a diagnostic block to the body. Development only.
    DIAG_ENABLED: false,
    DIAG_MAX_LINES: 400,
};

// ─── Diagnostic log (bounded) ─────────────────────────────────────────────────

const _diag = (function () {
    const t0 = Date.now();
    const buf = [];
    let n = 0;
    let lastStep = "(none)";

    function pad2(v) { return v < 10 ? "0" + v : String(v); }

    function step(label, detail) {
        n++;
        const id = "#" + pad2(n);
        lastStep = id + " " + label;
        const line = "+ " + (Date.now() - t0) + "ms " + id + " \u25B8 " + label +
            (detail !== undefined && detail !== null && detail !== "" ? " :: " + detail : "");
        buf.push(line);
        // The runtime can live for the whole Outlook session; never grow unbounded.
        if (buf.length > CONFIG.DIAG_MAX_LINES) buf.splice(0, buf.length - CONFIG.DIAG_MAX_LINES);
        try { if (typeof console !== "undefined") console.log("[CardByte]", line); } catch (_) { }
    }

    function truncate(s, max) {
        if (s === null || s === undefined) return "";
        const str = String(s);
        return str.length > max ? str.slice(0, max) + "\u2026[+" + (str.length - max) + "]" : str;
    }

    function html() {
        const header = "[CardByte DIAGNOSTIC \u2014 DELETE BEFORE SENDING]\nLAST STEP: " + lastStep +
            "\nSTEPS: " + n + " | ELAPSED: " + (Date.now() - t0) + "ms\n";
        const escaped = (header + "\n" + buf.join("\n"))
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return "<div style='margin:0 0 16px 0;padding:12px 16px;border:2px solid #d9534f;" +
            "border-radius:4px;background-color:#fff3cd;font-family:Consolas,monospace;" +
            "font-size:11px;color:#333;white-space:pre-wrap;'>" + escaped + "</div>";
    }

    return { step: step, truncate: truncate, html: html, lastStep: function () { return lastStep; } };
})();

// ─── Activation mode ──────────────────────────────────────────────────────────
//
// Send mode shrinks every ceiling on the critical path. Set by onSendHandler,
// cleared by the compose handlers, read by everything that waits on something.

let _sendMode = false;

function stepTimeoutMs() { return _sendMode ? CONFIG.SEND_ASYNC_STEP_TIMEOUT_MS : CONFIG.ASYNC_STEP_TIMEOUT_MS; }
function bodyReadTimeoutMs() { return _sendMode ? CONFIG.SEND_BODY_READ_TIMEOUT_MS : CONFIG.BODY_READ_TIMEOUT_MS; }
function xhrTimeoutMs() { return _sendMode ? CONFIG.SEND_XHR_TIMEOUT_MS : CONFIG.XHR_TIMEOUT_MS; }
function xhrMaxAttempts() { return _sendMode ? CONFIG.SEND_XHR_MAX_ATTEMPTS : CONFIG.XHR_MAX_ATTEMPTS; }

// Wraps a callback so it fires exactly once, within ms. Office.js callbacks on
// the critical path occasionally never return in the classic runtime.
function once(ms, label, cb) {
    let fired = false;
    const timer = setTimeout(function () {
        if (fired) return;
        fired = true;
        _diag.step("once:TIMEOUT", label + " after " + ms + "ms");
        cb(undefined, true);
    }, ms);
    return function (value) {
        if (fired) { _diag.step("once:late-ignored", label); return; }
        fired = true;
        clearTimeout(timer);
        cb(value, false);
    };
}

// ─── Plan-expiry latch ───────────────────────────────────────────────────────

const _plan = (function () {
    let expired = false;
    let message = null;
    return {
        reset: function () { expired = false; message = null; },
        isExpired: function () { return expired; },
        message: function () { return message || CONFIG.PLAN_EXPIRED_MSG; },
        note: function (serverMsg) {
            if (expired) return;
            expired = true;
            message = serverMsg || null;
            _diag.step("plan:EXPIRED", serverMsg || "(no server message)");
            if (CONFIG.CLEAR_CACHE_ON_PLAN_EXPIRED) purgeAllCaches();
        }
    };
})();

function _serverMessageOf(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    if (/^[\w$]+(\.[\w$]+){2,}$/.test(s)) return null;   // FQCN, not a message
    return s.length <= 140 ? s : null;
}

function _classifyErrorBody(status, rawBody) {
    let text = String(rawBody || "");
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (_) {
        const pt = decryptResponse(text);
        if (pt) { text = pt; try { parsed = JSON.parse(pt); } catch (__) { } }
    }
    return {
        planExpired: status === CONFIG.HTTP_PLAN_EXPIRED ||
            /PlanExpired/i.test(String((parsed && parsed.error) || text)),
        message: _serverMessageOf(parsed && parsed.message)
    };
}

// ─── Account scoping (multiple accounts in one Outlook profile) ──────────────
//
// OfficeRuntime.storage is shared by every account in the profile. The sender
// is read from item.from (the From dropdown), profile mailbox as fallback, and
// every storage key is namespaced by it. The in-memory copies carry an owner
// tag and are ignored when the owner differs.

let _senderEmail = "";

function _profileEmail() {
    try { return (Office.context.mailbox.userProfile.emailAddress || "").trim().toLowerCase(); }
    catch (_) { return ""; }
}

// Runs once per activation, before any cache read or backend call.
function resolveSender(item, cb) {
    const fallback = _profileEmail();
    const done = once(stepTimeoutMs(), "resolveSender", function (email, timedOut) {
        const next = (email || fallback || "").toLowerCase();
        if (next !== _senderEmail) dropMemoryCaches();
        _senderEmail = next;
        _diag.step("resolveSender", "sender=" + _senderEmail + " profile=" + fallback +
            (timedOut ? " (timed out, profile)" : "") +
            (_senderEmail && fallback && _senderEmail !== fallback ? " (From wins)" : ""));
        cb(_senderEmail);
    });

    if (!item || !item.from || typeof item.from.getAsync !== "function") { done(fallback); return; }
    try {
        item.from.getAsync(function (res) {
            let email = "";
            if (res.status === Office.AsyncResultStatus.Succeeded && res.value) {
                email = (res.value.emailAddress || "").trim().toLowerCase();
            }
            done(email || fallback);
        });
    } catch (e) { _diag.step("resolveSender:threw", e.message); done(fallback); }
}

function getUserEmail() { return _senderEmail || _profileEmail(); }

function accountKey() {
    const e = getUserEmail() || "unknown";
    return e.replace(/[\s/\\'"]/g, "_");   // storage keys: no whitespace, slashes, quotes
}

const K = {
    sig: function () { return CONFIG.CACHE_KEY + ":" + accountKey(); },
    rules: function () { return CONFIG.RULES_CACHE_KEY + ":" + accountKey(); },
    sigById: function () { return CONFIG.SIG_BY_ID_CACHE_KEY + ":" + accountKey(); },
    lastApplied: function () { return CONFIG.LAST_APPLIED_KEY + ":" + accountKey(); }
};

// ─── CryptoJS helpers (synchronous) ──────────────────────────────────────────

function encryptEmail(email) {
    if (!email || !email.trim()) return "";
    if (typeof CryptoJS === "undefined") { _diag.step("encryptEmail:CryptoJS-NOT-LOADED"); return ""; }
    try {
        const key = CryptoJS.enc.Base64.parse(CONFIG.AES_KEY_B64);
        const iv = CryptoJS.enc.Base64.parse(CONFIG.AES_IV_B64);
        return CryptoJS.AES.encrypt(email, key, { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString();
    } catch (e) { _diag.step("encryptEmail:threw", e.message); return ""; }
}

function decryptResponse(cipherB64) {
    if (!cipherB64) return "";
    if (typeof CryptoJS === "undefined") return "";
    try {
        const key = CryptoJS.enc.Base64.parse(CONFIG.AES_KEY_B64);
        const iv = CryptoJS.enc.Base64.parse(CONFIG.AES_IV_B64);
        return CryptoJS.AES.decrypt(cipherB64, key, { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 })
            .toString(CryptoJS.enc.Utf8);
    } catch (e) { _diag.step("decryptResponse:threw", e.message); return ""; }
}

// ─── OfficeRuntime.storage ────────────────────────────────────────────────────
//
// Every entry is { data, ts }. Reads report FRESH (within CACHE_TTL_MS) and
// STALE (within STALE_FALLBACK_MS) separately: cb(fresh, stale). Callers use
// fresh normally and stale only when the network has already failed. Entries
// older than the fallback window are evicted on read.

function _storageGet(key, cb) {
    try {
        OfficeRuntime.storage.getItem(key).then(
            function (raw) {
                if (!raw) { cb(null, null); return; }
                let entry;
                try { entry = JSON.parse(raw); } catch (_) { cb(null, null); return; }
                if (!entry || entry.data === null || entry.data === undefined) { cb(null, null); return; }
                const age = Date.now() - (entry.ts || 0);
                if (age > CONFIG.STALE_FALLBACK_MS) {
                    _diag.step("storage:evict", key + " age=" + age + "ms");
                    OfficeRuntime.storage.removeItem(key).then(function () { }, function () { });
                    cb(null, null);
                    return;
                }
                if (age > CONFIG.CACHE_TTL_MS) { _diag.step("storage:stale", key + " age=" + age + "ms"); cb(null, entry.data); return; }
                _diag.step("storage:hit", key);
                cb(entry.data, entry.data);
            },
            function (err) { _diag.step("storage:get-failed", key + " " + err); cb(null, null); }
        );
    } catch (e) { _diag.step("storage:get-threw", key + " " + e.message); cb(null, null); }
}

// Raw read with no TTL semantics — for maps that carry per-entry timestamps.
function _storageGetRaw(key, cb) {
    try {
        OfficeRuntime.storage.getItem(key).then(
            function (raw) {
                if (!raw) { cb(null); return; }
                let entry; try { entry = JSON.parse(raw); } catch (_) { cb(null); return; }
                cb(entry && entry.data !== undefined ? entry.data : null);
            },
            function () { cb(null); }
        );
    } catch (_) { cb(null); }
}

function _storageSet(key, data, cb) {
    let raw;
    try { raw = JSON.stringify({ data: data, ts: Date.now() }); }
    catch (e) { _diag.step("storage:stringify-threw", e.message); if (cb) cb(false); return; }
    try {
        OfficeRuntime.storage.setItem(key, raw).then(
            function () { _diag.step("storage:set", key + " bytes=" + raw.length); if (cb) cb(true); },
            function (err) { _diag.step("storage:set-failed", key + " " + err); if (cb) cb(false); }
        );
    } catch (e) { _diag.step("storage:set-threw", key + " " + e.message); if (cb) cb(false); }
}

function _storageRemove(key, cb) {
    try {
        OfficeRuntime.storage.removeItem(key).then(function () { if (cb) cb(); }, function () { if (cb) cb(); });
    } catch (_) { if (cb) cb(); }
}

// ─── In-memory layer (owner-tagged) ───────────────────────────────────────────

let _memSig = null, _memSigOwner = null, _memSigTs = 0;
let _memRules = null, _memRulesOwner = null, _memRulesTs = 0;
let _memLastApplied = null;

function dropMemoryCaches() {
    _memSig = null; _memSigOwner = null; _memSigTs = 0;
    _memRules = null; _memRulesOwner = null; _memRulesTs = 0;
    _memLastApplied = null;
}

// ─── Default-signature cache ──────────────────────────────────────────────────

// cb(fresh, stale)
function getCachedSignature(cb) {
    const owner = accountKey();
    if (_memSig && _memSigOwner === owner) {
        const fresh = Date.now() - _memSigTs <= CONFIG.CACHE_TTL_MS;
        _diag.step("getCachedSignature:memory", fresh ? "fresh" : "stale");
        if (fresh) { cb(_memSig, _memSig); return; }
    }
    _storageGet(K.sig(), function (fresh, stale) {
        if (fresh) { _memSig = fresh; _memSigOwner = owner; _memSigTs = Date.now(); }
        cb(fresh, stale || (_memSigOwner === owner ? _memSig : null));
    });
}

function setCachedSignature(html, cb) {
    _memSig = html; _memSigOwner = accountKey(); _memSigTs = Date.now();
    _storageSet(K.sig(), html, cb || function () { });
}

function purgeAllCaches() {
    _diag.step("purgeAllCaches", "account=" + accountKey());
    dropMemoryCaches();
    _storageRemove(K.sig());
    _storageRemove(K.rules());
    _storageRemove(K.sigById());
    _storageRemove(K.lastApplied());
}

// ─── Rules cache ──────────────────────────────────────────────────────────────

// cb(fresh, stale)
function getCachedRules(cb) {
    const owner = accountKey();
    if (_memRules && _memRulesOwner === owner && Date.now() - _memRulesTs <= CONFIG.CACHE_TTL_MS) {
        _diag.step("getCachedRules:memory", "fresh");
        cb(_memRules, _memRules);
        return;
    }
    _storageGet(K.rules(), function (fresh, stale) {
        if (fresh) { _memRules = fresh; _memRulesOwner = owner; _memRulesTs = Date.now(); }
        cb(fresh, stale || (_memRulesOwner === owner ? _memRules : null));
    });
}

function setCachedRules(rules, cb) {
    _memRules = rules; _memRulesOwner = accountKey(); _memRulesTs = Date.now();
    _diag.step("setCachedRules", "rules=" + ((rules && rules.rulesList) || []).length);
    _storageSet(K.rules(), rules, cb || function () { });
}

// ─── Per-signatureId HTML cache ───────────────────────────────────────────────

// cb(fresh, stale)
function getSigById(signatureId, cb) {
    _storageGetRaw(K.sigById(), function (map) {
        const entry = map ? map[String(signatureId)] : null;
        if (!entry || !entry.html) { cb(null, null); return; }
        const age = Date.now() - (entry.ts || 0);
        if (age > CONFIG.STALE_FALLBACK_MS) { cb(null, null); return; }
        if (age > CONFIG.CACHE_TTL_MS) { _diag.step("getSigById:stale", "id=" + signatureId); cb(null, entry.html); return; }
        _diag.step("getSigById:hit", "id=" + signatureId);
        cb(entry.html, entry.html);
    });
}

function setSigById(signatureId, html, cb) {
    _storageGetRaw(K.sigById(), function (map) {
        const m = map || {};
        const now = Date.now();
        // Evict anything past the fallback window while we have the map open.
        for (const k in m) {
            if (Object.prototype.hasOwnProperty.call(m, k) && now - ((m[k] && m[k].ts) || 0) > CONFIG.STALE_FALLBACK_MS) delete m[k];
        }
        m[String(signatureId)] = { html: html, ts: now };
        _storageSet(K.sigById(), m, cb || function () { });
    });
}

// ─── Last-applied record (redundant-write suppression + digest) ──────────────

function _itemKey(item) {
    try { if (item && item.conversationId) return String(item.conversationId); } catch (_) { }
    return "current";
}

function getLastApplied(item, cb) {
    const key = _itemKey(item), owner = accountKey();
    if (_memLastApplied && _memLastApplied.itemKey === key && _memLastApplied.owner === owner) { cb(_memLastApplied); return; }
    _storageGetRaw(K.lastApplied(), function (rec) {
        if (rec && rec.itemKey === key && rec.owner === owner && Date.now() - (rec.ts || 0) <= CONFIG.LAST_APPLIED_TTL_MS) {
            _memLastApplied = rec; cb(rec); return;
        }
        cb(null);
    });
}

function setLastApplied(item, sigKey, htmlLen, digest, cb) {
    const rec = { itemKey: _itemKey(item), owner: accountKey(), sigKey: String(sigKey), htmlLen: htmlLen || 0, digest: digest || null, ts: Date.now() };
    _memLastApplied = rec;
    _storageSet(K.lastApplied(), rec, cb || function () { });
}

// ─── XHR (bounded, retries only in compose mode) ─────────────────────────────

function xhrGet(url, headers, cb) {
    let attempt = 0;
    const maxAttempts = xhrMaxAttempts();
    const timeoutMs = xhrTimeoutMs();

    function fire() {
        attempt++;
        let xhr;
        try { xhr = new XMLHttpRequest(); } catch (e) { _diag.step("xhr:construct-failed", e.message); cb(null); return; }

        // Cache buster: mshtml is aggressive about heuristic caching, and a
        // cached 200 re-stamped with a fresh ts is what makes a TTL look inert.
        const u = url + (url.indexOf("?") === -1 ? "?" : "&") + "_=" + Date.now();
        _diag.step("xhr:open", "attempt=" + attempt + "/" + maxAttempts + " t=" + timeoutMs + "ms " + url);

        try {
            xhr.open("GET", u, true);
            xhr.timeout = timeoutMs;
            for (const k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) xhr.setRequestHeader(k, headers[k]);
        } catch (e) { _diag.step("xhr:open-threw", e.message); cb(null); return; }

        function retryOrFail(reason) {
            if (attempt < maxAttempts) {
                _diag.step("xhr:retry", reason);
                setTimeout(fire, CONFIG.XHR_RETRY_DELAY_MS);
            } else { _diag.step("xhr:give-up", reason + " after " + attempt); cb(null); }
        }

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            const body = xhr.responseText || "";
            _diag.step("xhr:done", "status=" + xhr.status + " len=" + body.length);
            if (xhr.status >= 200 && xhr.status < 300) { cb(body); return; }

            _diag.step("xhr:non-2xx-body", _diag.truncate(body, CONFIG.XHR_LOG_BODY_CHARS));
            const cls = _classifyErrorBody(xhr.status, body);
            if (cls.planExpired) { _plan.note(cls.message); cb(null); return; }

            // status 0 = blocked (AppDomains / CORS / offline). 408/409/429/5xx
            // look like transient collisions; other 4xx are decisions.
            const retryable = xhr.status === 0 || xhr.status === 408 || xhr.status === 409 || xhr.status === 429 || xhr.status >= 500;
            if (retryable) retryOrFail("status=" + xhr.status);
            else cb(null);
        };
        xhr.ontimeout = function () { retryOrFail("timeout"); };
        xhr.onerror = function () { retryOrFail("network-error"); };

        try { xhr.send(); } catch (e) { retryOrFail("send-threw " + e.message); }
    }
    fire();
}

function getXPlatform() {
    try {
        const p = Office.context.diagnostics.platform;
        if (p === Office.PlatformType.Mac || p === "Mac") return "MAC";
    } catch (_) { }
    return "WINDOWS";
}

function authHeaders(extra) {
    const email = getUserEmail();
    if (!email) { _diag.step("authHeaders:no-user-email"); return null; }
    const encrypted = encryptEmail(email);
    if (!encrypted) { _diag.step("authHeaders:encrypt-failed"); return null; }
    const h = { "username": encrypted, "X-Platform": getXPlatform() };
    if (extra) for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
}

// ─── Notifications ────────────────────────────────────────────────────────────
//
// icon must be a manifest image resid; errorMessage accepts neither icon nor
// persistent (the old details object threw and made every failure silent).

let _notifSeq = 0;

function _notifDetails(message, type) {
    const msg = message.length > 140 ? message.slice(0, 137) + "..." : message;
    if (type === "errorMessage") return { type: "errorMessage", message: msg };
    return { type: "informationalMessage", message: msg, icon: CONFIG.NOTIF_ICON, persistent: false };
}

function showNotification(item, message, type) {
    try {
        if (!item || !item.notificationMessages || typeof item.notificationMessages.replaceAsync !== "function") return;
        const details = _notifDetails(String(message || ""), type);
        if (!details.message) return;
        _notifSeq++;
        item.notificationMessages.replaceAsync(CONFIG.NOTIF_KEY, details, function (r) {
            if (r.status === Office.AsyncResultStatus.Succeeded) return;
            try { item.notificationMessages.addAsync(CONFIG.NOTIF_KEY, details, function () { }); } catch (_) { }
        });
    } catch (e) { _diag.step("showNotification:threw", e.message); }
}

function removeNotification(item) {
    try { if (item && item.notificationMessages) item.notificationMessages.removeAsync(CONFIG.NOTIF_KEY, function () { }); } catch (_) { }
}

function showLoading(item) { if (!_sendMode) showNotification(item, CONFIG.MSG_LOADING, "informationalMessage"); }

// Failure: the lapsed plan is the truer cause of anything else that failed.
function notifyFailure(item, message) {
    showNotification(item, _plan.isExpired() ? _plan.message() : message, "errorMessage");
}

// Success: "Signature applied" briefly (compose only), then clear — unless the
// plan has lapsed, which must stay visible.
function notifyApplied(item) {
    if (_plan.isExpired()) { showNotification(item, _plan.message(), "errorMessage"); return; }
    if (_sendMode) { removeNotification(item); return; }   // the item is already closing
    showNotification(item, CONFIG.MSG_APPLIED, "informationalMessage");
    const mine = _notifSeq;
    setTimeout(function () { if (mine === _notifSeq) removeNotification(item); }, CONFIG.NOTIFY_CLEAR_MS);
}

// ─── Item custom properties ───────────────────────────────────────────────────

function loadCustomProps(item, cb) {
    if (!item || typeof item.loadCustomPropertiesAsync !== "function") { cb(null); return; }
    const done = once(stepTimeoutMs(), "loadCustomProps", function (props) { cb(props || null); });
    try {
        item.loadCustomPropertiesAsync(function (res) {
            done(res.status === Office.AsyncResultStatus.Succeeded ? res.value : null);
        });
    } catch (e) { _diag.step("loadCustomProps:threw", e.message); done(null); }
}

// Fire-and-forget. A fresh bag is loaded before every write because saveAsync
// serialises the whole bag — a stale one would delete the pane's pin.
function setItemProps(item, kv) {
    loadCustomProps(item, function (props) {
        if (!props) return;
        try {
            for (const k in kv) {
                if (!Object.prototype.hasOwnProperty.call(kv, k)) continue;
                if (kv[k] === null || kv[k] === undefined) props.remove(k);
                else props.set(k, String(kv[k]));
            }
            props.saveAsync(function (r) {
                if (r.status !== Office.AsyncResultStatus.Succeeded) _diag.step("setItemProps:save-failed", (r.error && r.error.message) || "?");
            });
        } catch (e) { _diag.step("setItemProps:threw", e.message); }
    });
}

function getManualOverride(item, cb) {
    loadCustomProps(item, function (props) {
        let id = null;
        try { id = props ? props.get(CONFIG.MANUAL_OVERRIDE_PROP) : null; } catch (_) { id = null; }
        const s = id == null ? "" : String(id).trim();
        if (s === "" || s === "null" || s === "undefined") { cb(null); return; }
        _diag.step("getManualOverride", "id=" + s);
        cb(s);
    });
}

// ─── Guarded event.completed ──────────────────────────────────────────────────
//
// defaultOpts is what the guard passes when it has to complete on the caller's
// behalf. For OnMessageSend that MUST be {allowEvent:true}: completing with no
// options blocks the send (v6 note 1). The guard also refuses to fire while a
// setSignatureAsync callback is outstanding — completing mid-write loses it.

let _injecting = false;

function makeGuardedEvent(event, timeoutMs, defaultOpts) {
    let done = false;
    let timer = null;

    function arm(ms) {
        timer = setTimeout(function () {
            if (done) return;
            if (_injecting) { _diag.step("guard:write-in-flight", "grace=" + CONFIG.GUARD_INJECT_GRACE_MS); arm(CONFIG.GUARD_INJECT_GRACE_MS); return; }
            _diag.step("guard:TIMEOUT", "after " + ms + "ms — completing with " + JSON.stringify(defaultOpts || null));
            complete(defaultOpts);
        }, ms);
    }

    function complete(opts) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        const o = opts || defaultOpts;
        _diag.step("guard:complete", "opts=" + JSON.stringify(o || null));
        flushDiagnostics(_lastItemForDiag, function () {
            try { if (o) event.completed(o); else event.completed(); }
            catch (e) { _diag.step("event.completed:threw", e.message); }
        });
    }

    arm(timeoutMs);
    return { completed: complete, isDone: function () { return done; } };
}

// ─── Backend fetchers ─────────────────────────────────────────────────────────

let _defaultSigInFlight = null;

function fetchDefaultSignature(cb) {
    if (_defaultSigInFlight) { _defaultSigInFlight.push(cb); return; }
    _defaultSigInFlight = [cb];
    function finish(html) {
        const waiters = _defaultSigInFlight || [];
        _defaultSigInFlight = null;
        waiters.forEach(function (w) { try { w(html); } catch (e) { _diag.step("fetchDefault:cb-threw", e.message); } });
    }
    const headers = authHeaders();
    if (!headers) { finish(null); return; }
    xhrGet(CONFIG.BASE_URL + "/html/outlook/get-active", headers, function (raw) {
        if (!raw) { finish(null); return; }
        const pt = decryptResponse(raw);
        let parsed = null;
        try { parsed = JSON.parse(pt || raw); } catch (e) { _diag.step("fetchDefault:parse-error", e.message); finish(null); return; }
        const html = parsed && parsed.html;
        if (!html) { _diag.step("fetchDefault:no-html"); finish(null); return; }
        _diag.step("fetchDefault:ok", "len=" + html.length);
        setCachedSignature(html, function () { finish(html); });
    });
}

function fetchRulesConfig(cb) {
    const headers = authHeaders({ "Content-Type": "application/json" });
    if (!headers) { cb(null); return; }
    xhrGet(CONFIG.BASE_URL + "/rules-config/get-active", headers, function (raw) {
        if (!raw) { cb(null); return; }
        let parsed = null;
        try { parsed = JSON.parse(raw); }
        catch (_) { const pt = decryptResponse(raw); try { parsed = pt ? JSON.parse(pt) : null; } catch (__) { parsed = null; } }
        const rulesJson = parsed && parsed.rulesJson;
        if (!rulesJson) { _diag.step("fetchRules:no-rulesJson"); cb(null); return; }
        _diag.step("fetchRules:ok", "rules=" + ((rulesJson.rulesList) || []).length);
        setCachedRules(rulesJson);
        cb(rulesJson);
    });
}

function fetchSignatureById(signatureId, cb) {
    const headers = authHeaders();
    if (!headers) { cb(null); return; }
    xhrGet(CONFIG.BASE_URL + "/rules-config/get/" + encodeURIComponent(signatureId), headers, function (raw) {
        if (!raw) { cb(null); return; }
        let parsed = null;
        try { parsed = JSON.parse(raw); }
        catch (_) { const pt = decryptResponse(raw); try { parsed = pt ? JSON.parse(pt) : null; } catch (__) { parsed = null; } }
        const html = parsed && parsed.html;
        if (!html) { _diag.step("fetchSigById:no-html", "id=" + signatureId); cb(null); return; }
        _diag.step("fetchSigById:ok", "id=" + signatureId + " len=" + html.length);
        setSigById(signatureId, html);
        cb(html);
    });
}

// ─── HTML resolution: fresh cache → network → stale copy ─────────────────────
//
// The ONE place any signature id becomes HTML. cb(htmlOrNull, source).

function resolveSigHtml(id, cb) {
    const key = String(id == null ? "" : id);
    if (!key || key === "null" || key === "undefined") { cb(null, "none"); return; }

    function done(html, source) {
        if (html) _diag.step("resolveSigHtml", "id=" + key + " source=" + source);
        cb(html || null, html ? source : "none");
    }

    function fromNetwork(stale) {
        const go = key === CONFIG.DEFAULT_ID ? fetchDefaultSignature : function (c) { fetchSignatureById(key, c); };
        go(function (html) {
            if (html) { done(html, "network"); return; }
            if (stale) { _diag.step("resolveSigHtml:serving-stale", "id=" + key); done(stale, "cache-stale"); return; }
            done(null, "none");
        });
    }

    const read = key === CONFIG.DEFAULT_ID ? getCachedSignature : function (c) { getSigById(key, c); };
    read(function (fresh, stale) {
        if (fresh) { done(fresh, "cache"); return; }
        // At send a stale copy of the RIGHT id beats a network round trip.
        if (_sendMode && stale) { done(stale, "cache-stale"); return; }
        fromNetwork(stale);
    });
}

// ─── Recipients (three-valued) ────────────────────────────────────────────────
//
//   null  — the host did not answer. Nothing can be concluded.
//   []    — the host answered: no recipients. This IS an answer.
//   [...] — recipients.

function getRecipientsAsync(field, label, cb) {
    if (!field || typeof field.getAsync !== "function") { cb([]); return; }
    const done = once(stepTimeoutMs(), "recipients:" + label, function (v, timedOut) { cb(timedOut ? null : v); });
    try {
        field.getAsync(function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded) done(result.value || []);
            else { _diag.step("recipients:failed", label + " " + ((result.error && result.error.message) || "?")); done(null); }
        });
    } catch (e) { _diag.step("recipients:threw", label + " " + e.message); done(null); }
}

function getAllRecipientEmails(item, cb) {
    getRecipientsAsync(item.to, "to", function (toList) {
        if (toList === null) { cb(null); return; }          // To unreadable → whole picture unusable
        getRecipientsAsync(item.cc, "cc", function (ccList) {
            if (ccList === null) { _diag.step("recipients:cc-unreadable", "evaluating To only"); ccList = []; }
            const all = [], seen = {};
            toList.concat(ccList).forEach(function (r) {
                const e = ((r && r.emailAddress) || "").toLowerCase().trim();
                if (e && !seen[e]) { seen[e] = true; all.push(e); }
            });
            _diag.step("recipients", "unique=" + all.length + " [" + all.join(",") + "]");
            cb(all);
        });
    });
}

// ─── Rule matching ────────────────────────────────────────────────────────────

function getDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function recipientTypeMatches(recipientType, hasInternal, hasExternal) {
    const rt = (recipientType || "").toLowerCase().trim();
    if (!rt || rt === "all") return true;
    if (rt === "internal") return hasInternal;
    if (rt === "external") return hasExternal;
    return true;
}

function _ruleSenders(rule) {
    if (!rule) return null;
    const names = ["Senders", "senders", "SenderEmails", "senderEmails", "senderList", "SenderList", "Sender", "sender"];
    for (let i = 0; i < names.length; i++) {
        const v = rule[names[i]];
        if (Array.isArray(v)) return v;
        if (typeof v === "string" && v.trim() !== "") return [v];
        if (v && typeof v === "object") return [v];
    }
    return null;
}

function _senderEntryMatches(entry, me, myDomain) {
    let s = "";
    if (typeof entry === "string") s = entry;
    else if (entry && typeof entry === "object") {
        s = entry.email || entry.emailAddress || entry.address || entry.smtpAddress || entry.userPrincipalName || entry.upn || "";
    }
    s = String(s || "").trim().toLowerCase();
    if (!s) return false;
    if (s === "*" || s === "all") return true;
    if (s === me) return true;
    if (s.indexOf("*@") === 0) return !!myDomain && s.slice(2) === myDomain;
    if (s.indexOf("@") === 0) return !!myDomain && s.slice(1) === myDomain;
    if (s.indexOf("@") === -1) return !!myDomain && s === myDomain;
    return false;
}

function senderMatches(rule) {
    const list = _ruleSenders(rule);
    if (!list || list.length === 0) return true;   // no restriction
    const me = getUserEmail().toLowerCase(), myDomain = getDomain(me);
    for (let i = 0; i < list.length; i++) if (_senderEntryMatches(list[i], me, myDomain)) return true;
    return false;
}

function normalizeContext(v) {
    const s = (v || "").trim().toLowerCase();
    if (s === "" || s === "all" || s === "any") return "all";
    if (s === "compose" || s === "new" || s === "newmail" || s === "newmessage") return "compose";
    if (s === "reply" || s === "replyall" || s === "reply-all") return "reply";
    if (s === "forward" || s === "fwd") return "forward";
    return s;
}

function isContextAgnostic(rule) { return normalizeContext(rule && rule.context) === "all"; }

function contextMatches(ruleContext, composeType) {
    const rc = normalizeContext(ruleContext);
    if (rc === "all") return true;
    if (composeType === null || composeType === undefined) return false;   // conservative
    const ct = normalizeContext(composeType);
    if (rc === ct) return true;
    return CONFIG.TREAT_FORWARD_AS_REPLY && rc === "reply" && ct === "forward";
}

// The ONE filter deciding which rules are candidates. Must agree with the
// taskpane's `r.enabled && r.signatureId`.
function enabledRulesWithSignatures(rules) {
    const all = ((rules && rules.rulesList) || []).filter(function (r) { return r && r.enabled; });
    const usable = all.filter(function (r) {
        return r.signatureId !== null && r.signatureId !== undefined && String(r.signatureId).trim() !== "";
    });
    if (all.length !== usable.length) _diag.step("rules:dropped", (all.length - usable.length) + " enabled rule(s) without signatureId");
    return usable.sort(function (a, b) { return (Number(a.priority) || 0) - (Number(b.priority) || 0); });
}

// ─── Compose type ─────────────────────────────────────────────────────────────
//
// cb("compose" | "reply" | "forward" | null). null = unknown: context-agnostic
// rules still match, context-scoped ones cannot. Never guess "compose".

const REPLY_PREFIX_RE = /^\s*(re|aw|sv|vs|antw|res|ref|odp|回复)\s*(\[\d+\])?\s*:/i;
const FORWARD_PREFIX_RE = /^\s*(fw|fwd|wg|tr|vb|rv|enc|转发)\s*(\[\d+\])?\s*:/i;

function getComposeType(item, cb) {
    const done = once(stepTimeoutMs(), "composeType", function (v, timedOut) { cb(timedOut ? null : v); });

    function viaSubject() {
        if (!item.subject || typeof item.subject.getAsync !== "function") { viaInReplyTo(); return; }
        try {
            item.subject.getAsync(function (res) {
                if (res.status === Office.AsyncResultStatus.Succeeded) {
                    const subj = String(res.value || "");
                    if (FORWARD_PREFIX_RE.test(subj)) { done("forward"); return; }
                    if (REPLY_PREFIX_RE.test(subj)) { done("reply"); return; }
                }
                viaInReplyTo();
            });
        } catch (_) { viaInReplyTo(); }
    }
    function viaInReplyTo() {
        try { if (item.inReplyToId) { done("reply"); return; } } catch (_) { }
        _diag.step("composeType:UNDETERMINED");
        done(null);
    }

    if (typeof item.getComposeTypeAsync !== "function") { viaSubject(); return; }
    try {
        item.getComposeTypeAsync(function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                const raw = ((result.value && result.value.composeType) || "").toLowerCase();
                _diag.step("composeType:api", raw || "(empty)");
                if (raw === "forward") { done("forward"); return; }
                if (raw === "reply") { done("reply"); return; }
                if (raw === "newmail") { done("compose"); return; }
            }
            viaSubject();
        });
    } catch (_) { viaSubject(); }
}

// ─── findMatchingRule ────────────────────────────────────────────────────────
//
// cb({ rule, blocked }). blocked = could not evaluate safely (recipients
// unreadable, or the top candidate is context-scoped and the compose type is
// unknown); the caller must keep whatever was already decided.

function findMatchingRule(item, rules, cb) {
    const senderEmail = getUserEmail(), senderDomain = getDomain(senderEmail);
    const ruleList = enabledRulesWithSignatures(rules);
    if (!ruleList.length) { cb({ rule: null, blocked: false }); return; }

    getAllRecipientEmails(item, function (emails) {
        if (emails === null) { _diag.step("findMatchingRule:recipients-unreadable", "→ blocked"); cb({ rule: null, blocked: true }); return; }
        if (emails.length === 0 && CONFIG.EMPTY_RECIPIENTS_MEANS_DEFAULT) {
            _diag.step("findMatchingRule:no-recipients", "→ default");
            cb({ rule: null, blocked: false });
            return;
        }

        let hasInternal = false, hasExternal = false;
        emails.forEach(function (e) {
            const d = getDomain(e);
            if (!d) return;
            if (senderDomain && d === senderDomain) hasInternal = true; else hasExternal = true;
        });

        // Everything decidable WITHOUT the compose type, in priority order.
        const candidates = ruleList.filter(function (r) {
            return senderMatches(r) && recipientTypeMatches(r.recipientType, hasInternal, hasExternal);
        });
        _diag.step("findMatchingRule", "sender=" + senderEmail + " recips=" + emails.length +
            " internal=" + hasInternal + " external=" + hasExternal + " rules=" + ruleList.length + " candidates=" + candidates.length);

        if (!candidates.length) { cb({ rule: null, blocked: false }); return; }

        // Compose type is only consulted when a surviving candidate cares.
        if (candidates.every(isContextAgnostic)) {
            _diag.step("findMatchingRule:MATCH", "priority=" + candidates[0].priority + " sigId=" + candidates[0].signatureId + " (context-agnostic)");
            cb({ rule: candidates[0], blocked: false });
            return;
        }

        getComposeType(item, function (composeType) {
            if (composeType === null && !isContextAgnostic(candidates[0])) {
                // Unknown context and the winner depends on it: undecidable.
                // Only block at SEND — at compose the default is a fine interim
                // answer and the send re-evaluates with a populated draft.
                if (_sendMode) { _diag.step("findMatchingRule:undecidable", "→ blocked"); cb({ rule: null, blocked: true }); return; }
            }
            for (let i = 0; i < candidates.length; i++) {
                const r = candidates[i];
                if (contextMatches(r.context, composeType)) {
                    _diag.step("findMatchingRule:MATCH", "priority=" + r.priority + " context=" + r.context + " sigId=" + r.signatureId);
                    cb({ rule: r, blocked: false });
                    return;
                }
            }
            _diag.step("findMatchingRule:none-matched", "→ default");
            cb({ rule: null, blocked: false });
        });
    });
}

// ─── Signature verification (tamper detection) ────────────────────────────────

const HCS = typeof HtmlContentSignature !== "undefined" ? HtmlContentSignature : null;
const SIG_PROFILE = HCS ? HCS.PROFILES.body : null;

function escAttr(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Decision keys are "default" | "rule:<id>" | "override:<id>"; the marker in
// the body carries the bare id, which is what the pane and the WebView build
// write and look for.
function sigIdOf(sigKey) {
    const s = String(sigKey == null ? "" : sigKey), c = s.indexOf(":");
    return c === -1 ? s : s.slice(c + 1);
}

function wrapSignature(html, sigKey) {
    return "<div " + CONFIG.SIG_MARK_ATTR + "=\"" + escAttr(sigIdOf(sigKey)) + "\">" + html + "</div>";
}

let _digestCache = { html: null, digest: null };
function sigDigest(html) {
    if (!HCS || html == null) return null;
    if (_digestCache.html === html) return _digestCache.digest;
    let d = null;
    try { d = HCS.digest(html, SIG_PROFILE); } catch (e) { _diag.step("sigDigest:threw", e.message); return null; }
    _digestCache = { html: html, digest: d };
    return d;
}

// cb(htmlOrNull). null = could not read; "" is a legitimate empty draft.
function readBodyHtml(item, cb) {
    if (!item || !item.body || typeof item.body.getAsync !== "function") { cb(null); return; }
    const done = once(bodyReadTimeoutMs(), "readBodyHtml", function (value, timedOut) { cb(timedOut || value === undefined ? null : value); });
    try {
        item.body.getAsync(Office.CoercionType.Html, function (res) {
            if (res.status === Office.AsyncResultStatus.Succeeded) done(String(res.value == null ? "" : res.value));
            else { _diag.step("readBodyHtml:failed", (res.error && res.error.message) || "?"); done(undefined); }
        });
    } catch (e) { _diag.step("readBodyHtml:threw", e.message); done(undefined); }
}

/**
 * Is `expectedHtml` still intact on the draft? cb({ verdict, reason })
 *   identical — untouched. The ONLY verdict that suppresses a write.
 *   modified / absent / duplicate / id-changed / unknown — write it.
 * Only the LIVE area of a reply is inspected: the quoted thread routinely holds
 * an intact copy of the same signature from an earlier mail we signed.
 */
function verifySignatureOnBody(item, expectedHtml, sigKey, cb) {
    if (!CONFIG.VERIFY_BEFORE_WRITE) { cb({ verdict: "unknown", reason: "verification disabled" }); return; }
    if (!HCS) { _diag.step("verify:HCS-NOT-LOADED"); cb({ verdict: "unknown", reason: "module missing" }); return; }

    readBodyHtml(item, function (body) {
        if (body === null) { cb({ verdict: "unknown", reason: "body unreadable" }); return; }
        const opt = {};
        for (const k in SIG_PROFILE) if (Object.prototype.hasOwnProperty.call(SIG_PROFILE, k)) opt[k] = SIG_PROFILE[k];
        opt.markAttr = CONFIG.SIG_MARK_ATTR;
        opt.sigId = sigIdOf(sigKey);
        try {
            // Word strips unknown attributes on insertion, so data-cb-sig is
            // often gone from an untouched signature. With no marked region,
            // fall back to a token-run search of the live area — a deleted
            // signature still comes back "absent".
            const marked = HCS.extractMarkedRegions(body, CONFIG.SIG_MARK_ATTR);
            let r;
            if (!marked.length) {
                const split = HCS.splitDraftAtQuote(body);
                r = HCS.verifyRegion(expectedHtml, split.live, opt);
                r.scope = (split.boundary < body.length ? "live-of-reply" : "whole-body") + " (marker-free)";
            } else {
                r = HCS.verifyInDraft(expectedHtml, body, opt);
            }
            _diag.step("verify:" + r.verdict, "sigKey=" + sigKey + " scope=" + r.scope + (r.reason ? " " + r.reason : ""));
            cb({ verdict: r.verdict, reason: r.scope + ": " + (r.reason || "") });
        } catch (e) {
            _diag.step("verify:threw", e.message);
            cb({ verdict: "unknown", reason: "comparison failed: " + e.message });
        }
    });
}

// ─── Body writes ──────────────────────────────────────────────────────────────

function writeSignature(item, html, sigKey, onDone) {
    if (!item || !item.body || typeof item.body.setSignatureAsync !== "function") {
        _diag.step("writeSignature:unavailable");
        notifyFailure(item, CONFIG.MSG_WRITE_FAILED);
        onDone(false);
        return;
    }
    _injecting = true;
    const payload = wrapSignature(html, sigKey);
    _diag.step("writeSignature:begin", "sigKey=" + sigKey + " payload=" + payload.length);

    let settled = false;
    function settle(ok, why) {
        if (settled) return;
        settled = true;
        _injecting = false;
        _diag.step("writeSignature:end", "ok=" + ok + (why ? " " + why : ""));
        onDone(ok);
    }

    try {
        item.body.setSignatureAsync(payload, { coercionType: Office.CoercionType.Html }, function (r) {
            if (r.status === Office.AsyncResultStatus.Succeeded) {
                const digest = sigDigest(html);
                // What the pane reads to show the active signature.
                const kv = {}; kv[CONFIG.P_ACTIVE_SIG] = sigIdOf(sigKey); kv[CONFIG.P_SIG_DIGEST] = digest;
                setItemProps(item, kv);
                setLastApplied(item, sigKey, html.length, digest, function () { settle(true); });
            } else {
                const msg = (r.error && r.error.message) || "?";
                notifyFailure(item, CONFIG.MSG_WRITE_FAILED);
                settle(false, msg);
            }
        });
    } catch (e) { settle(false, e.message); }
}

// Write only if needed: identical key moments ago → skip without a body read;
// otherwise verify the draft and write only when it is not already correct.
// onDone(ok, wrote)
function writeSignatureIfChanged(item, html, sigKey, onDone) {
    if (!html) { onDone(false, false); return; }
    getLastApplied(item, function (last) {
        // The shortcut is for recipient storms at compose. Send is the last
        // chance to catch an edit, so it always reads the draft.
        if (!_sendMode && last && last.sigKey === String(sigKey) && last.htmlLen === html.length &&
            Date.now() - last.ts < CONFIG.REDUNDANT_WRITE_WINDOW_MS) {
            _diag.step("write:suppressed-redundant", "sigKey=" + sigKey);
            onDone(true, false);
            return;
        }
        verifySignatureOnBody(item, html, sigKey, function (v) {
            if (v.verdict === "identical") {
                _diag.step("write:draft-clean", "sigKey=" + sigKey);
                setLastApplied(item, sigKey, html.length, sigDigest(html), function () { onDone(true, false); });
                return;
            }
            writeSignature(item, html, sigKey, function (ok) { onDone(ok, ok); });
        });
    });
}

// ─── Diagnostics flush ────────────────────────────────────────────────────────

let _lastItemForDiag = null;

function flushDiagnostics(item, onDone) {
    if (!CONFIG.DIAG_ENABLED || _sendMode || !item || !item.body || typeof item.body.prependAsync !== "function") { onDone(); return; }
    try { item.body.prependAsync(_diag.html(), { coercionType: Office.CoercionType.Html }, function () { onDone(); }); }
    catch (_) { onDone(); }
}

// =============================================================================
//  THE PIPELINE
// =============================================================================

/**
 * Phase 1 — default first, fast. onDone(appliedOrNot)
 */
function applyDefaultSignature(item, onDone) {
    _diag.step("PHASE1:enter");
    showLoading(item);
    resolveSigHtml(CONFIG.DEFAULT_ID, function (html, source) {
        if (!html) {
            _diag.step("PHASE1:no-default", "cache, network and stale copy all empty");
            onDone(false);
            return;
        }
        writeSignatureIfChanged(item, html, "default", function (ok) {
            _diag.step("PHASE1:done", "source=" + source + " ok=" + ok);
            onDone(ok);
        });
    });
}

/**
 * Decide which signature SHOULD be on the item. cb({ key, id, blocked })
 *   key: "default" | "rule:<id>"   id: the resolvable signature id
 */
function determineTarget(item, cb) {
    function withRules(rules) {
        if (!rules || !((rules.rulesList || []).length)) { cb({ key: "default", id: CONFIG.DEFAULT_ID, blocked: false }); return; }
        findMatchingRule(item, rules, function (res) {
            if (res.blocked) { cb({ key: null, id: null, blocked: true }); return; }
            if (!res.rule) { cb({ key: "default", id: CONFIG.DEFAULT_ID, blocked: false }); return; }
            const id = String(res.rule.signatureId);
            cb({ key: "rule:" + id, id: id, blocked: false });
        });
    }
    getCachedRules(function (fresh, stale) {
        if (fresh) { withRules(fresh); return; }
        // At send a stale ruleset beats a network round trip.
        if (_sendMode && stale) { _diag.step("determineTarget:stale-rules-at-send"); withRules(stale); return; }
        fetchRulesConfig(function (fetched) {
            if (fetched) { withRules(fetched); return; }
            if (stale) { _diag.step("determineTarget:fetch-failed-using-stale"); withRules(stale); return; }
            // No rules at all: not blocked — the default is the honest answer,
            // and a persisted decision (if any) is respected by the caller.
            cb({ key: null, id: null, blocked: true, noRules: true });
        });
    });
}

/**
 * Phase 2 — reconcile what IS on the item with what SHOULD be. onDone(finalKeyOrNull)
 * default→rule, rule→rule and rule→default all pass through here.
 */
function reconcileSignature(item, onDone) {
    _diag.step("PHASE2:enter");
    determineTarget(item, function (target) {
        getLastApplied(item, function (last) {
            let key = target.key, id = target.id;
            if (target.blocked) {
                // Could not evaluate. Keep what was decided for this item; if
                // nothing was, the default is the safest thing to put there.
                if (last && last.sigKey) { key = last.sigKey; id = sigIdOf(last.sigKey); _diag.step("PHASE2:blocked-keeping", key); }
                else { key = "default"; id = CONFIG.DEFAULT_ID; _diag.step("PHASE2:blocked-nothing-decided", "→ default"); }
            }
            _diag.step("PHASE2:target", "last=" + (last ? last.sigKey : "(none)") + " target=" + key);

            resolveSigHtml(id, function (html) {
                if (html) {
                    writeSignatureIfChanged(item, html, key, function (ok) { onDone(ok ? key : null); });
                    return;
                }
                if (id !== CONFIG.DEFAULT_ID) {
                    _diag.step("PHASE2:rule-html-unavailable", "id=" + id + " → default");
                    resolveSigHtml(CONFIG.DEFAULT_ID, function (def) {
                        if (!def) { onDone(null); return; }
                        writeSignatureIfChanged(item, def, "default", function (ok) { onDone(ok ? "default" : null); });
                    });
                    return;
                }
                onDone(null);
            });
        });
    });
}

/**
 * Phase 3 — warm the per-id cache for the next activation. Compose only.
 */
function prefetchRuleSignatures(rules, onDone) {
    const list = enabledRulesWithSignatures(rules).filter(senderMatches);
    let i = 0;
    function next() {
        if (i >= list.length) { onDone(); return; }
        const id = String(list[i++].signatureId);
        getSigById(id, function (fresh) {
            if (fresh) { next(); return; }
            fetchSignatureById(id, function () { next(); });
        });
    }
    if (list.length) _diag.step("prefetch", list.length + " rule signature(s)");
    next();
}

/**
 * Full sequence: override → (default) → rules → complete → prefetch.
 * opts.skipDefaultPhase — send: one decision, one write.
 */
function runPipeline(item, guarded, opts) {
    const options = opts || {};

    function finish(finalKey, appliedSomething) {
        if (finalKey) notifyApplied(item);
        else if (!appliedSomething) notifyFailure(item, CONFIG.MSG_UNAVAILABLE);

        if (_sendMode) { guarded.completed(); return; }      // no prefetch at send
        // Prefetch BEFORE completing: code after event.completed() may not run.
        getCachedRules(function (fresh, stale) {
            const rules = fresh || stale;
            if (rules) prefetchRuleSignatures(rules, function () { guarded.completed(); });
            else guarded.completed();
        });
    }

    getManualOverride(item, function (overrideId) {
        if (overrideId) {
            _diag.step("PIPELINE:manual-override", "id=" + overrideId);
            resolveSigHtml(overrideId, function (html) {
                if (!html) { _diag.step("PIPELINE:override-unresolvable", "→ default+rules"); defaultThenRules(); return; }
                writeSignatureIfChanged(item, html, "override:" + overrideId, function (ok) { finish(ok ? "override:" + overrideId : null, ok); });
            });
            return;
        }
        defaultThenRules();
    });

    function defaultThenRules() {
        function thenReconcile(defaultApplied) {
            reconcileSignature(item, function (finalKey) {
                _diag.step("PIPELINE:settled", "sigKey=" + (finalKey || "none"));
                finish(finalKey, defaultApplied);
            });
        }
        if (options.skipDefaultPhase) { thenReconcile(false); return; }
        // Phase 1 puts SOMETHING on a cold draft while the rules resolve. Once a
        // decision exists for this item, going through it again would write the
        // default and then the rule — the visible insert-and-replace cycle.
        getLastApplied(item, function (last) {
            if (last) { _diag.step("PHASE1:skipped", "already decided (" + last.sigKey + ")"); thenReconcile(false); return; }
            applyDefaultSignature(item, thenReconcile);
        });
    }
}

// ─── Compose item resolution (with retry) ────────────────────────────────────

function _rawItem() {
    try { return (Office && Office.context && Office.context.mailbox) ? Office.context.mailbox.item : null; } catch (_) { return null; }
}

function resolveComposeItem(cb) {
    let attempts = 0;
    const max = _sendMode ? CONFIG.SEND_ITEM_RETRY_ATTEMPTS : CONFIG.ITEM_RETRY_ATTEMPTS;
    function attempt() {
        attempts++;
        const item = _rawItem();
        if (item && item.body && typeof item.body.setSignatureAsync === "function") { _lastItemForDiag = item; cb(item); return; }
        if (attempts >= max) { _diag.step("resolveComposeItem:FAILED", "attempts=" + attempts); _lastItemForDiag = item; cb(null); return; }
        setTimeout(attempt, CONFIG.ITEM_RETRY_DELAY_MS);
    }
    attempt();
}

// =============================================================================
//  ENTRY POINTS
// =============================================================================

function _beginActivation(name, sendMode) {
    _sendMode = !!sendMode;
    _plan.reset();
    _diag.step(name + ":ENTRY", CONFIG.VERSION + (sendMode ? " (send mode)" : ""));
}

// OnNewMessageCompose
function applySignature(event) {
    _beginActivation("applySignature", false);
    const guarded = makeGuardedEvent(event || { completed: function () { } }, CONFIG.COMPOSE_HANDLER_TIMEOUT_MS, null);
    resolveComposeItem(function (item) {
        if (!item) { guarded.completed(); return; }
        resolveSender(item, function () { runPipeline(item, guarded, {}); });
    });
}

// OnMessageRecipientsChanged — pure reconcile: default→rule, rule→rule,
// rule→default. No Phase 1 (rewriting the default first would flicker).
function onRecipientsChangedHandler(event) {
    _beginActivation("onRecipientsChanged", false);
    const guarded = makeGuardedEvent(event || { completed: function () { } }, CONFIG.COMPOSE_HANDLER_TIMEOUT_MS, null);
    resolveComposeItem(function (item) {
        if (!item) { guarded.completed(); return; }
        resolveSender(item, function () { runPipeline(item, guarded, { skipDefaultPhase: true }); });
    });
}

// OnMessageSend (SoftBlock) — last chance to get it right. The send is ALWAYS
// allowed: every completion here, including the guard's, is {allowEvent:true}.
function onSendHandler(event) {
    _beginActivation("onSend", true);
    const ALLOW = { allowEvent: true };
    const guarded = makeGuardedEvent(event || { completed: function () { } }, CONFIG.SEND_HANDLER_TIMEOUT_MS, ALLOW);
    try {
        resolveComposeItem(function (item) {
            if (!item) { guarded.completed(ALLOW); return; }
            resolveSender(item, function () { runPipeline(item, guarded, { skipDefaultPhase: true }); });
        });
    } catch (e) {
        _diag.step("onSend:threw", e.message);
        guarded.completed(ALLOW);
    }
}

// OnMessageFromChanged — storage is namespaced per account, so re-resolving
// the sender switches the whole pipeline to the new account's namespace.
function onFromChangedHandler(event) {
    _beginActivation("onFromChanged", false);
    const guarded = makeGuardedEvent(event || { completed: function () { } }, CONFIG.COMPOSE_HANDLER_TIMEOUT_MS, null);
    resolveComposeItem(function (item) {
        if (!item) { guarded.completed(); return; }
        dropMemoryCaches();
        _senderEmail = "";
        resolveSender(item, function (email) {
            _diag.step("onFromChanged:new-sender", email);
            // The previous decision belongs to the previous account.
            const kv = {}; kv[CONFIG.P_ACTIVE_SIG] = null; kv[CONFIG.P_SIG_DIGEST] = null;
            setItemProps(item, kv);
            runPipeline(item, guarded, { skipDefaultPhase: true });
        });
    });
}

// ─── Registration ─────────────────────────────────────────────────────────────
//
// Office.initialize / Office.onReady do NOT run for a manifest-declared event
// handler in the classic JS-only runtime, so associate at top level.

(function registerHandlers() {
    if (typeof Office === "undefined") {
        try { console.error("[CardByte] Office is undefined — JSRuntime load failed"); } catch (_) { }
        return;
    }
    function doRegister(source) {
        try {
            Office.actions.associate("applySignature", applySignature);
            Office.actions.associate("onSendHandler", onSendHandler);
            Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
            Office.actions.associate("onRecipientsChangedHandler", onRecipientsChangedHandler);
            _diag.step("registerHandlers", "via=" + source + " " + CONFIG.VERSION);
        } catch (e) { _diag.step("registerHandlers:threw", e.message); }
    }
    if (Office.actions && typeof Office.actions.associate === "function") { doRegister("top-level"); return; }
    Office.initialize = function () { doRegister("Office.initialize"); };
    try { if (typeof Office.onReady === "function") Office.onReady(function () { doRegister("Office.onReady"); }); } catch (_) { }
})();