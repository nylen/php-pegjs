/*
 *   The MIT License (MIT)
 *
 *   Copyright (c) 2014 Elantcev Mikhail
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

var arrayUtils = require("pegjs/lib/utils/arrays"),
    asts = require("pegjs/lib/compiler/asts"),
    op = require("pegjs/lib/compiler/opcodes"),
    internalUtils = require("../utils");

/* Generates parser Php code. */
module.exports = function(ast, options) {

    /* These only indent non-empty lines to avoid trailing whitespace. */
    function indent2(code) {
        return code.replace(/^(.+)$/gm, '  $1');
    }
    function indent4(code) {
        return code.replace(/^(.+)$/gm, '    $1');
    }
    function indent8(code) {
        return code.replace(/^(.+)$/gm, '        $1');
    }
    function indent10(code) {
        return code.replace(/^(.+)$/gm, '          $1');
    }

    function generateTablesDeclaration() {
        return arrayUtils.map(
            ast.consts,
            function(c, i) {
                return 'private $peg_c' + i + ';';
            }
        ).join('\n');
    }

    function generateTablesDefinition() {
        return arrayUtils.map(
            ast.consts,
            function(c, i) {
                return '$this->peg_c' + i + ' = ' + c + ';';
            }
        ).join('\n');
    }

    function generateFunctions() {
        return arrayUtils.map(
            ast.functions,
            function( c, i ) {
                return 'private function peg_f' + i
                    + '(' + c.params + ') {'
                    + c.code
                    + '}';
            }
        ).join('\n');
    }

    function generateCacheHeader(ruleIndexCode) {
        return [
            '$key    = $this->peg_currPos * ' + ast.rules.length + ' + ' + ruleIndexCode + ';',
            '    $cached = isset($this->peg_cache[$key]) ? $this->peg_cache[$key] : null;',
            '',
            'if ($cached) {',
            '  $this->peg_currPos = $cached["nextPos"];',
            '  return $cached["result"];',
            '}',
            ''
        ].join('\n');
    }

    function generateCacheFooter(resultCode) {
        return [
            '',
            '$this->peg_cache[$key] = array ("nextPos" => $this->peg_currPos, "result" => ' + resultCode + ' );'
        ].join('\n');
    }

    function generateRuleFunction(rule) {
        var parts = [], code;

        function c(i) {
            return "$this->peg_c" + i;
        } // |consts[i]| of the abstract machine
        function f(i) {
            return "$this->peg_f" + i;
        } // |functions[i]| of the abstract machine
        function s(i) {
            return "$s" + i;
        } // |stack[i]| of the abstract machine

        function inputSubstr(start, len) {
            if ( len === 1 ) {
                return "$this->input[" + start + "]";
            } else {
                return "$this->input_substr(" + start + ", " + len + ")";
            }
        }

        var stack = {
            sp: -1,
            maxSp: -1,
            push: function(exprCode) {
                var code = s(++this.sp) + ' = ' + exprCode + ';';

                if (this.sp > this.maxSp) {
                    this.maxSp = this.sp;
                }

                return code;
            },
            pop: function() {
                var n, values;

                if (arguments.length === 0) {
                    return s(this.sp--);
                } else {
                    n = arguments[0];
                    values = arrayUtils.map(arrayUtils.range(this.sp - n + 1, this.sp + 1), s);
                    this.sp -= n;

                    return values;
                }
            },
            top: function() {
                return s(this.sp);
            },
            index: function(i) {
                return s(this.sp - i);
            }
        };

        function compile(bc) {
            var ip = 0,
                    end = bc.length,
                    parts = [],
                    stackTop,
                    value;

            function compileCondition(cond, argCount) {
                var baseLength = argCount + 3,
                        thenLength = bc[ip + baseLength - 2],
                        elseLength = bc[ip + baseLength - 1],
                        baseSp = stack.sp,
                        thenCode, elseCode, thenSp, elseSp;

                ip += baseLength;
                thenCode = compile(bc.slice(ip, ip + thenLength));
                thenSp = stack.sp;
                ip += thenLength;

                if (elseLength > 0) {
                    stack.sp = baseSp;
                    elseCode = compile(bc.slice(ip, ip + elseLength));
                    elseSp = stack.sp;
                    ip += elseLength;

                    if (thenSp !== elseSp) {
                        throw new Error(
                                "Branches of a condition must move the stack pointer in the same way."
                                );
                    }
                }

                parts.push('if (' + cond + ') {');
                parts.push(indent2(thenCode));
                if (elseLength > 0) {
                    parts.push('} else {');
                    parts.push(indent2(elseCode));
                }
                parts.push('}');
            }

            function compileLoop(cond) {
                var baseLength = 2,
                        bodyLength = bc[ip + baseLength - 1],
                        baseSp = stack.sp,
                        bodyCode, bodySp;

                ip += baseLength;
                bodyCode = compile(bc.slice(ip, ip + bodyLength));
                bodySp = stack.sp;
                ip += bodyLength;

                if (bodySp !== baseSp) {
                    throw new Error("Body of a loop can't move the stack pointer.");
                }

                parts.push('while (' + cond + ') {');
                parts.push(indent2(bodyCode));
                parts.push('}');
            }

            function compileCall() {
                var baseLength = 4,
                        paramsLength = bc[ip + baseLength - 1];

                var params = bc.slice(ip + baseLength, ip + baseLength + paramsLength);
                var value = f(bc[ip + 1]) + '(';
                if (params.length > 0) {
                    value +=  arrayUtils.map(
                        params,
                        stackIndex
                    ).join(', ');
                }
                value += ')';
                stack.pop(bc[ip + 2]);
                parts.push(stack.push(value));
                ip += baseLength + paramsLength;
            }

            /*
             * Extracted into a function just to silence JSHint complaining about
             * creating functions in a loop.
             */
            function stackIndex(p) {
                return stack.index(p);
            }

            while (ip < end) {
                switch (bc[ip]) {
                    case op.PUSH:             // PUSH c
                        parts.push(stack.push(c(bc[ip + 1])));
                        ip += 2;
                        break;

                    case op.PUSH_UNDEFINED:   // PUSH_UNDEFINED
                        parts.push(stack.push('null'));
                        ip++;
                        break;

                    case op.PUSH_NULL:        // PUSH_NULL
                        parts.push(stack.push('null'));
                        ip++;
                        break;

                    case op.PUSH_FAILED:      // PUSH_FAILED
                        parts.push(stack.push('$this->peg_FAILED'));
                        ip++;
                        break;

                    case op.PUSH_EMPTY_ARRAY: // PUSH_EMPTY_ARRAY
                        parts.push(stack.push('array()'));
                        ip++;
                        break;

                    case op.PUSH_CURR_POS:    // PUSH_CURR_POS
                        parts.push(stack.push('$this->peg_currPos'));
                        ip++;
                        break;

                    case op.POP:              // POP
                        stack.pop();
                        ip++;
                        break;

                    case op.POP_CURR_POS:     // POP_CURR_POS
                        parts.push('$this->peg_currPos = ' + stack.pop() + ';');
                        ip++;
                        break;

                    case op.POP_N:            // POP_N n
                        stack.pop(bc[ip + 1]);
                        ip += 2;
                        break;

                    case op.NIP:              // NIP
                        value = stack.pop();
                        stack.pop();
                        parts.push(stack.push(value));
                        ip++;
                        break;

                    case op.APPEND:           // APPEND
                        value = stack.pop();
                        parts.push(stack.top() + '[] = ' + value + ';');
                        ip++;
                        break;

                    case op.WRAP:             // WRAP n
                        parts.push(
                            stack.push('array(' + stack.pop(bc[ip + 1]).join(', ') + ')')
                        );
                        ip += 2;
                        break;

                    case op.TEXT:             // TEXT
                        stackTop = stack.pop();
                        parts.push(stack.push(
                            inputSubstr(
                                stackTop,
                                '$this->peg_currPos - ' + stackTop
                            )
                        ));
                        ip++;
                        break;

                    case op.IF:               // IF t, f
                        compileCondition(stack.top(), 0);
                        break;

                    case op.IF_ERROR:         // IF_ERROR t, f
                        compileCondition(stack.top() + ' === $this->peg_FAILED', 0);
                        break;

                    case op.IF_NOT_ERROR:     // IF_NOT_ERROR t, f
                        compileCondition(stack.top() + ' !== $this->peg_FAILED', 0);
                        break;

                    case op.WHILE_NOT_ERROR:  // WHILE_NOT_ERROR b
                        compileLoop(stack.top() + ' !== $this->peg_FAILED', 0);
                        break;

                    case op.MATCH_ANY:        // MATCH_ANY a, f, ...
                        compileCondition('$this->input_length > $this->peg_currPos', 0);
                        break;

                    case op.MATCH_STRING:     // MATCH_STRING s, a, f, ...
                        compileCondition(
                            inputSubstr(
                                '$this->peg_currPos',
                                eval(ast.consts[bc[ip + 1]]).length
                            ) + ' === ' + c(bc[ip + 1]),
                            1
                        );
                        break;

                    case op.MATCH_STRING_IC:  // MATCH_STRING_IC s, a, f, ...
                        compileCondition(
                            'mb_strtolower(' + inputSubstr(
                                '$this->peg_currPos',
                                eval(ast.consts[bc[ip + 1]]).length
                            ) + ', "UTF-8") === ' + c(bc[ip + 1]),
                            1
                        );
                        break;

                    case op.MATCH_REGEXP:     // MATCH_REGEXP r, a, f, ...
                        compileCondition(
                            phpGlobalNamePrefix + 'peg_regex_test('
                            + c(bc[ip + 1]) + ', '
                            + inputSubstr('$this->peg_currPos', 1)
                            + ')',
                            1
                        );
                        break;

                    case op.ACCEPT_N:         // ACCEPT_N n
                        parts.push(stack.push(
                            inputSubstr('$this->peg_currPos', bc[ip + 1])
                        ));
                        parts.push(
                            bc[ip + 1] > 1
                                ? '$this->peg_currPos += ' + bc[ip + 1] + ';'
                                : '$this->peg_currPos++;'
                        );
                        ip += 2;
                        break;

                    case op.ACCEPT_STRING:    // ACCEPT_STRING s
                        parts.push(stack.push(c(bc[ip + 1])));
                        parts.push(
                            eval(ast.consts[bc[ip + 1]]).length > 1
                                ? '$this->peg_currPos += ' + eval(ast.consts[bc[ip + 1]]).length + ';'
                                : '$this->peg_currPos++;'
                                );
                        ip += 2;
                        break;

                    case op.FAIL:             // FAIL e
                        parts.push(stack.push('$this->peg_FAILED'));
                        parts.push('if ($this->peg_silentFails === 0) {');
                        parts.push('    $this->peg_fail(' + c(bc[ip + 1]) + ');');
                        parts.push('}');
                        ip += 2;
                        break;

                    case op.LOAD_SAVED_POS:   // LOAD_SAVED_POS p
                        parts.push('$this->peg_reportedPos = ' + stack.index(bc[ip + 1]) + ';');
                        ip += 2;
                        break;

                    case op.UPDATE_SAVED_POS: // UPDATE_SAVED_POS
                        parts.push('$this->peg_reportedPos = $this->peg_currPos;');
                        ip++;
                        break;

                    case op.CALL:             // CALL f, n, pc, p1, p2, ..., pN
                        compileCall();
                        break;

                    case op.RULE:             // RULE r
                        parts.push(stack.push("$this->peg_parse" + ast.rules[bc[ip + 1]].name + "()"));
                        ip += 2;
                        break;

                    case op.SILENT_FAILS_ON:  // SILENT_FAILS_ON
                        parts.push('$this->peg_silentFails++;');
                        ip++;
                        break;

                    case op.SILENT_FAILS_OFF: // SILENT_FAILS_OFF
                        parts.push('$this->peg_silentFails--;');
                        ip++;
                        break;

                    default:
                        throw new Error("Invalid opcode: " + bc[ip] + ".");
                }
            }

            return parts.join('\n');
        }

        code = compile(rule.bytecode);

        parts.push([
            'private function peg_parse' + rule.name + '() {',
            ''
        ].join('\n'));

        if (options.cache) {
            parts.push(indent2(
                    generateCacheHeader(asts.indexOfRule(ast, rule.name))
                    ));
        }

        parts.push(indent2(code));

        if (options.cache) {
            parts.push(indent2(generateCacheFooter(s(0))));
        }

        parts.push([
            '',
            '  return ' + s(0) + ';',
            '}'
        ].join('\n'));

        return parts.join('\n');
    }

    var parts = [], startRuleFunctions, startRuleFunction;
    var phpGlobalNamePrefix, phpGlobalNamespacePrefix, phpGlobalNamePrefixOrNamespaceEscaped;
    var phpNamespace = options.phpegjs.parserNamespace;
    var phpParserClass = options.phpegjs.parserClassName;
    if (phpNamespace) {
        phpGlobalNamePrefix = '';
        phpGlobalNamespacePrefix = '\\';
        // For use within strings inside generated code
        phpGlobalNamePrefixOrNamespaceEscaped = phpNamespace + '\\\\';
    } else if (options.phpegjs.parserGlobalNamePrefix) {
        phpGlobalNamePrefix = options.phpegjs.parserGlobalNamePrefix;
        phpGlobalNamespacePrefix = '';
        phpGlobalNamePrefixOrNamespaceEscaped = phpGlobalNamePrefix;
        phpParserClass = phpGlobalNamePrefix + phpParserClass;
    } else {
        phpGlobalNamePrefix = '';
        phpGlobalNamespacePrefix = '';
        phpGlobalNamePrefixOrNamespaceEscaped = '';
    }

    parts.push([
        '<?php',
        '/*',
        ' * Generated by PEG.js 0.10.x with phpegjs plugin',
        ' *',
        ' * http://pegjs.majda.cz/',
        ' */',
        ''].join('\n'));
    if (phpNamespace) parts.push('namespace ' + phpNamespace + ';');
    parts.push(['',
        '/* Useful functions: */',
        '',
        '/* ' + phpGlobalNamePrefix + 'chr_unicode - get unicode character from its char code */',
        'if (!function_exists("' + phpGlobalNamePrefixOrNamespaceEscaped + 'chr_unicode")) {',
        '    function ' + phpGlobalNamePrefix + 'chr_unicode($code) {',
        '        return html_entity_decode("&#$code;", ENT_QUOTES, "UTF-8");',
        '    }',
        '}',
        '/* ' + phpGlobalNamePrefix + 'peg_regex_test - multibyte regex test */',
        'if (!function_exists("' + phpGlobalNamePrefixOrNamespaceEscaped + 'peg_regex_test")) {',
        '    function ' + phpGlobalNamePrefix + 'peg_regex_test($pattern, $string) {',
        '        if (substr($pattern, -1) == "i") {',
        '            return mb_eregi(substr($pattern, 1, -2), $string);',
        '        } else {',
        '            return mb_ereg(substr($pattern, 1, -1), $string);',
        '        }',
        '    }',
        '}',
        '',
        '/* Syntax error exception */',
        'if (!class_exists("' + phpGlobalNamePrefixOrNamespaceEscaped + 'SyntaxError", false)) {',
        '    class ' + phpGlobalNamePrefix + 'SyntaxError extends ' + phpGlobalNamespacePrefix + 'Exception {',
        '        public $expected;',
        '        public $found;',
        '        public $grammarOffset;',
        '        public $grammarLine;',
        '        public $grammarColumn;',
        '        public $name;',
        '        public function __construct($message, $expected, $found, $offset, $line, $column) {',
        '            parent::__construct($message, 0);',
        '            $this->expected = $expected;',
        '            $this->found = $found;',
        '            $this->grammarOffset = $offset;',
        '            $this->grammarLine = $line;',
        '            $this->grammarColumn = $column;',
        '            $this->name = "' + phpGlobalNamePrefix + 'SyntaxError";',
        '        }',
        '    }',
        '}',
        '',
        'class ' + phpParserClass + ' {',
    ].join('\n'));

    parts.push([
        '    private $peg_currPos          = 0;',
        '    private $peg_reportedPos      = 0;',
        '    private $peg_cachedPos        = 0;',
        '    private $peg_cachedPosDetails = array(\'line\' => 1, \'column\' => 1, \'seenCR\' => false );',
        '    private $peg_maxFailPos       = 0;',
        '    private $peg_maxFailExpected  = array();',
        '    private $peg_silentFails      = 0;', // 0 = report failures, > 0 = silence failures
        '    private $input                = array();',
        ''
    ].join('\n'));

    if (options.cache) {
        parts.push('    public $peg_cache = array();');
    }

    parts.push([
        '',
        '    private function cleanup_state() {',
        '      $this->peg_currPos          = 0;',
        '      $this->peg_reportedPos      = 0;',
        '      $this->peg_cachedPos        = 0;',
        "      $this->peg_cachedPosDetails = array('line' => 1, 'column' => 1, 'seenCR' => false );",
        '      $this->peg_maxFailPos       = 0;',
        '      $this->peg_maxFailExpected  = array();',
        '      $this->peg_silentFails      = 0;',
        '      $this->input                = array();',
        '      $this->input_length         = 0;',

               options.cache ?
        '      $this->peg_cache = array();' : '',

        '    }',
        '',
        '    private function input_substr($start, $length) {',
        '      $substr = \'\';',
        '      $max = min($start + $length, $this->input_length);',
        '      for ($i = $start; $i < $max; $i++) {',
        '        $substr .= $this->input[$i];',
        '      }',
        '      return $substr;',
        '    }',
        ''
    ].join('\n'));

    parts.push([
        '',
        '    private function text() {',
        '      return substr($this->input, $this->peg_reportedPos, $this->peg_reportedPos + $this->peg_currPos);',
        '    }',
        '',
        '    private function offset() {',
        '      return $this->peg_reportedPos;',
        '    }',
        '',
        '    private function line() {',
        '      $compute_pd = $this->peg_computePosDetails($this->peg_reportedPos);',
        '      return $compute_pd["line"];',
        '    }',
        '',
        '    private function column() {',
        '      $compute_pd = $this->peg_computePosDetails($this->peg_reportedPos);',
        '      return $compute_pd["column"];',
        '    }',
        '',
        '    private function expected($description) {',
        '      throw $this->peg_buildException(',
        '        null,',
        '        array(array("type" => "other", "description" => $description )),',
        '        $this->peg_reportedPos',
        '      );',
        '    }',
        '',
        '    private function error($message) {',
        '      throw $this->peg_buildException($message, null, $this->peg_reportedPos);',
        '    }',
        '',
        '    private function peg_advancePos(&$details, $startPos, $endPos) {',
        '      for ($p = $startPos; $p < $endPos; $p++) {',
        '        $ch = $this->input[$p];',
        '        if ($ch === "\\n") {',
        '          if (!$details["seenCR"]) { $details["line"]++; }',
        '          $details["column"] = 1;',
        '          $details["seenCR"] = false;',
        '        } else if ($ch === "\\r" || $ch === "\\u2028" || $ch === "\\u2029") {',
        '          $details["line"]++;',
        '          $details["column"] = 1;',
        '          $details["seenCR"] = true;',
        '        } else {',
        '          $details["column"]++;',
        '          $details["seenCR"] = false;',
        '        }',
        '      }',
        '    }',
        '',
        '    private function peg_computePosDetails($pos) {',
        '      if ($this->peg_cachedPos !== $pos) {',
        '        if ($this->peg_cachedPos > $pos) {',
        '          $this->peg_cachedPos = 0;',
        '          $this->peg_cachedPosDetails = array( "line" => 1, "column" => 1, "seenCR" => false );',
        '        }',
        '        $this->peg_advancePos($this->peg_cachedPosDetails, $this->peg_cachedPos, $pos);',
        '        $this->peg_cachedPos = $pos;',
        '      }',
        '',
        '      return $this->peg_cachedPosDetails;',
        '    }',
        '',
        '    private function peg_fail($expected) {',
        '      if ($this->peg_currPos < $this->peg_maxFailPos) { return; }',
        '',
        '      if ($this->peg_currPos > $this->peg_maxFailPos) {',
        '        $this->peg_maxFailPos = $this->peg_currPos;',
        '        $this->peg_maxFailExpected = array();',
        '      }',
        '',
        '      $this->peg_maxFailExpected[] = $expected;',
        '    }',
        '',
        '    private function peg_buildException_expectedComparator($a, $b) {',
        '      if ($a["description"] < $b["description"]) {',
        '        return -1;',
        '      } else if ($a["description"] > $b["description"]) {',
        '        return 1;',
        '      } else {',
        '        return 0;',
        '      }',
        '    }',
        '',
        '    private function peg_buildException($message, $expected, $pos) {',
        '      $posDetails = $this->peg_computePosDetails($pos);',
        '      $found      = $pos < $this->input_length ? $this->input[$pos] : null;',
        '',
        '      if ($expected !== null) {',
        '        usort($expected, array($this, "peg_buildException_expectedComparator"));',
        '        $i = 1;',
        /*
         * This works because the bytecode generator guarantees that every
         * expectation object exists only once, so it's enough to use |===| instead
         * of deeper structural comparison.
         */
        '        while ($i < count($expected)) {',
        '          if ($expected[$i - 1] === $expected[$i]) {',
        '            array_splice($expected, $i, 1);',
        '          } else {',
        '            $i++;',
        '          }',
        '        }',
        '      }',
        '',
        '      if ($message === null) {',
        '        $expectedDescs = array_fill(0, count($expected), null);',
        '',
        '        for ($i = 0; $i < count($expected); $i++) {',
        '          $expectedDescs[$i] = $expected[$i]["description"];',
        '        }',
        '',
        '        $expectedDesc = count($expected) > 1',
        '          ? join(", ", array_slice($expectedDescs, 0, -1))',
        '              . " or "',
        '              . $expectedDescs[count($expected) - 1]',
        '          : $expectedDescs[0];',
        '',
        '        $foundDesc = $found ? json_encode($found) : "end of input";',
        '',
        '        $message = "Expected " . $expectedDesc . " but " . $foundDesc . " found.";',
        '      }',
        '',
        '      return new ' + phpGlobalNamePrefix + 'SyntaxError(',
        '        $message,',
        '        $expected,',
        '        $found,',
        '        $pos,',
        '        $posDetails["line"],',
        '        $posDetails["column"]',
        '      );',
        '    }',
        ''
    ].join('\n'));

    parts.push('    private $peg_FAILED;');
    parts.push(indent4(generateTablesDeclaration()));
    parts.push('');
    parts.push(indent4(generateFunctions()));
    parts.push('');

    arrayUtils.each(ast.rules, function(rule) {
        parts.push(indent4(generateRuleFunction(rule)));
        parts.push('');
    });

    parts.push([
        '  public function parse($input) {',
        '    $arguments = func_get_args();',
        '    $options = count($arguments) > 1 ? $arguments[1] : array();',
        '    $this->cleanup_state();',
        '',
        // TODO: The `u` modifier is not always availale.  See:
        // - https://core.trac.wordpress.org/browser/tags/4.8/src/wp-includes/compat.php?annotate=blame#L16
        // - https://core.trac.wordpress.org/changeset/32364
        // - https://core.trac.wordpress.org/ticket/32165 (light on details)
        // - https://core.trac.wordpress.org/ticket/22692
        // - https://core.trac.wordpress.org/ticket/22363
        '    preg_match_all("/./us", $input, $match);',
        '    $this->input = $match[0];',
        '    $this->input_length = count($this->input);',
        '',
        '    $old_regex_encoding = mb_regex_encoding();',
        '    mb_regex_encoding("UTF-8");',
        ''
    ].join('\n'));

    parts.push(indent4('$this->peg_FAILED = new ' + phpGlobalNamespacePrefix + 'stdClass;'));
    parts.push(indent4(generateTablesDefinition()));
    parts.push('');
    
    startRuleFunctions = 'array( '
            + arrayUtils.map(
                    options.allowedStartRules,
                    function(r) {
                        return '\'' + r + '\' => array($this, "peg_parse' + r + '")';
                    }
            ).join(', ')
            + ' )';
    startRuleFunction = 'array($this, "peg_parse' + options.allowedStartRules[0] + '")';

    parts.push([
        '    $peg_startRuleFunctions = ' + startRuleFunctions + ';',
        '    $peg_startRuleFunction  = ' + startRuleFunction + ';'
    ].join('\n'));

    parts.push([
        '    if (isset($options["startRule"])) {',
        '      if (!(isset($peg_startRuleFunctions[$options["startRule"]]))) {',
        '        throw new ' + phpGlobalNamespacePrefix + 'Exception("Can\'t start parsing from rule \\"" + $options["startRule"] + "\\".");',
        '      }',
        '',
        '      $peg_startRuleFunction = $peg_startRuleFunctions[$options["startRule"]];',
        '    }'
    ].join('\n'));

    if (ast.initializer) {
        parts.push('');
        parts.push(indent4('/* BEGIN initializer code */'));
        parts.push(indent4(
            internalUtils.extractPhpCode(ast.initializer.code)
        ));
        parts.push(indent4('/* END initializer code */'));
        parts.push('');
    }

    parts.push('    $peg_result = call_user_func($peg_startRuleFunction);');

    if (options.cache) {
        parts.push('');
        parts.push('    $this->peg_cache = array();');
    }

    parts.push([
        '',
        '    mb_regex_encoding($old_regex_encoding);',
        '    if ($peg_result !== $this->peg_FAILED && $this->peg_currPos === $this->input_length) {',
        '      $this->cleanup_state(); // Free up memory',
        '      return $peg_result;',
        '    } else {',
        '      if ($peg_result !== $this->peg_FAILED && $this->peg_currPos < $this->input_length) {',
        '        $this->peg_fail(array("type" => "end", "description" => "end of input" ));',
        '      }',
        '',
        '      $exception = $this->peg_buildException(null, $this->peg_maxFailExpected, $this->peg_maxFailPos);',
        '      $this->cleanup_state(); // Free up memory',
        '      throw $exception;',
        '    }',
        '  }',
        '',
        '};'
    ].join('\n'));

    ast.code = parts.join('\n');
};
