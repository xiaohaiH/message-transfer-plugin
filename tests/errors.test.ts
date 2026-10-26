import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as errors from '../src/errors.js';
import * as core from '../src/index.js';

// 错误码常量同时提供运行时值和字符串字面量类型, 异常使用同一组错误码.
test('error-code constants are exported from the package entry with stable wire values', () => {
    const codes = Reflect.get(errors, 'ReceiverErrorCode');
    assert.deepEqual(codes, {
        INVALID_CONFIG: 'INVALID_CONFIG',
        INVALID_MESSAGE: 'INVALID_MESSAGE',
        INVALID_GROUP: 'INVALID_GROUP',
        INVALID_NAME: 'INVALID_NAME',
        FILE_NAME_CONFLICT: 'FILE_NAME_CONFLICT',
        MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
        UNAUTHORIZED: 'UNAUTHORIZED',
        FORBIDDEN: 'FORBIDDEN',
        PROCESSING_FAILED: 'PROCESSING_FAILED',
        WRITE_FAILED: 'WRITE_FAILED',
        DIRECTORY_UNAVAILABLE: 'DIRECTORY_UNAVAILABLE',
        START_FAILED: 'START_FAILED',
        TRANSPORT_ERROR: 'TRANSPORT_ERROR',
        SERVER_BUSY: 'SERVER_BUSY',
        SHUTTING_DOWN: 'SHUTTING_DOWN',
    });
    assert.equal(Reflect.get(core, 'ReceiverErrorCode'), codes);
});

test('ReceiverError accepts enum values without changing message, cause or serialized receipt codes', () => {
    const codes = Reflect.get(core, 'ReceiverErrorCode');
    assert.ok(codes, 'The public entry must provide runtime error-code constants');
    const code: core.ReceiverErrorCode = codes.WRITE_FAILED;
    const cause = new Error('local diagnostic');
    const error = new core.ReceiverError(code, 'Could not append to the group file.', { cause });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ReceiverError');
    assert.equal(error.code, 'WRITE_FAILED');
    assert.equal(error.cause, cause);
    assert.deepEqual(JSON.parse(JSON.stringify({ code: error.code, message: error.message })), {
        code: 'WRITE_FAILED',
        message: 'Could not append to the group file.',
    });
});
