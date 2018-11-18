import BpmnErrorActivity from '../../src/error/BpmnError';
import Environment from '../../src/Environment';

describe('BpmnError', () => {
  it('returns BpmnError instanceof from error', () => {
    const bpmnError = BpmnErrorActivity({
      id: 'Error_0',
      name: 'TestError',
    }, {environment: Environment()});

    const err = bpmnError.resolve({}, new Error('Men'));

    expect(err).to.have.property('id', 'Error_0');
    expect(err).to.have.property('name', 'TestError');
  });

  it('resolves errorCode expression', () => {
    const bpmnError = BpmnErrorActivity({
      id: 'Error_0',
      name: 'TestError',
      behaviour: {
        errorCode: 'EMES',
      },
    }, {environment: Environment()});

    const err = bpmnError.resolve({
      resolveExpression(errorCode) {
        return errorCode;
      },
    }, new Error('Men'));

    expect(err).to.have.property('errorCode', 'EMES');
  });
});
