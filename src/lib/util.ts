import {
    RPCGenericError,
    RPCNotImplementedError,
    RPCNotSupportedError,
    RPCInternalError,
    RPCProtocolError,
    RPCSecurityError,
    RPCFormationViolationError,
    RPCFormatViolationError,
    RPCPropertyConstraintViolationError,
    RPCOccurenceConstraintViolationError,
    RPCOccurrenceConstraintViolationError,
    RPCTypeConstraintViolationError,
    RPCMessageTypeNotSupportedError,
    RPCFrameworkError,
    RPCError,
} from './errors';
import { name, version } from '../../package.json';

export type OCPPErrorType = 'GenericError' |
    'NotImplemented' |
    'NotSupported' |
    'InternalError' |
    'ProtocolError' |
    'SecurityError' |
    'FormationViolation' |
    'FormatViolation' |
    'PropertyConstraintViolation' |
    'OccurenceConstraintViolation' |
    'OccurrenceConstraintViolation' |
    'TypeConstraintViolation' |
    'MessageTypeNotSupported' |
    'RpcFrameworkError';

export function getPackageIdent() {
    return `${name}/${version} (${process.platform})`;
}

export function translateErrorToOCPPCode(keyword: string): OCPPErrorType {
    switch (keyword) {
        default:
        case 'maximum':
        case 'minimum':
        case 'maxLength':
        case 'minLength':
            return "FormatViolation";
        case 'exclusiveMaximum':
        case 'exclusiveMinimum':
        case 'multipleOf':
        case 'maxItems':
        case 'minItems':
        case 'maxProperties':
        case 'minProperties':
        case 'additionalItems':
        case 'required':
            return "OccurenceConstraintViolation";
        case 'pattern':
        case 'propertyNames':
        case 'additionalProperties':
            return "PropertyConstraintViolation";
        case 'type':
            return "TypeConstraintViolation";
    }
}

const rpcErrorLUT = {
    'GenericError'                  : RPCGenericError,
    'NotImplemented'                : RPCNotImplementedError,
    'NotSupported'                  : RPCNotSupportedError,
    'InternalError'                 : RPCInternalError,
    'ProtocolError'                 : RPCProtocolError,
    'SecurityError'                 : RPCSecurityError,
    'FormationViolation'            : RPCFormationViolationError,
    'FormatViolation'               : RPCFormatViolationError,
    'PropertyConstraintViolation'   : RPCPropertyConstraintViolationError,
    'OccurenceConstraintViolation'  : RPCOccurenceConstraintViolationError,
    'OccurrenceConstraintViolation' : RPCOccurrenceConstraintViolationError,
    'TypeConstraintViolation'       : RPCTypeConstraintViolationError,
    'MessageTypeNotSupported'       : RPCMessageTypeNotSupportedError,
    'RpcFrameworkError'             : RPCFrameworkError,
};

interface ErrorPlainObject {
    stack: string;
    message: string;
}

export function getErrorPlainObject(err: Error): ErrorPlainObject {
    try {

        // (nasty hack)
        // attempt to serialise into JSON to ensure the error is, in fact, serialisable
        return JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));

    } catch (e) {
        // cannot serialise into JSON.
        // return just stack and message instead
        return {
            stack: err?.stack ?? '',
            message: err?.message ?? '',
        };
    }
}

export function createRPCError(type: OCPPErrorType, message?: string, details?: object) {
    const E = rpcErrorLUT[type] ?? RPCGenericError;
    const err = new E(message ?? '');
    err.details = details ?? {};
    return err;
}