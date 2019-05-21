"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = ProcessExecution;

var _Api = require("../Api");

var _messageHelper = require("../messageHelper");

function ProcessExecution(parentActivity, context) {
  const {
    id,
    type,
    broker,
    logger,
    isSubProcess
  } = parentActivity;
  const {
    environment
  } = context;
  const children = context.getActivities(id) || [];
  const flows = context.getSequenceFlows(id) || [];
  const outboundMessageFlows = context.getMessageFlows(id) || [];
  const childIds = children.map(({
    id: childId
  }) => childId);
  const startActivities = [];
  const postponed = [];
  const exchangeName = isSubProcess ? 'subprocess-execution' : 'execution';
  broker.assertExchange(exchangeName, 'topic', {
    autoDelete: false,
    durable: true
  });
  let activityQ,
      status = 'init',
      executionId,
      stopped,
      activated,
      apiConsumer,
      initMessage,
      completed = false;
  const processExecution = {
    id,
    type,
    broker,

    get environment() {
      return environment;
    },

    get executionId() {
      return executionId;
    },

    get completed() {
      return completed;
    },

    get status() {
      return status;
    },

    get stopped() {
      return stopped;
    },

    get postponedCount() {
      return postponed.length;
    },

    get isRunning() {
      if (activated) return true;
      return false;
    },

    deactivate,
    discard,
    execute,
    getApi,
    getActivityById,
    getActivities,
    getPostponed,
    getSequenceFlows,
    getState,
    recover,
    stop
  };
  return processExecution;

  function execute(executeMessage) {
    if (!executeMessage) throw new Error('Process execution requires message');
    if (!executeMessage.content || !executeMessage.content.executionId) throw new Error('Process execution requires execution id');
    const isRedelivered = executeMessage.fields.redelivered;
    executionId = executeMessage.content.executionId;
    initMessage = (0, _messageHelper.cloneMessage)(executeMessage);
    initMessage.content = { ...initMessage.content,
      executionId,
      state: 'start'
    };
    stopped = false;
    environment.assignVariables(executeMessage);
    activityQ = broker.assertQueue(`execute-${executionId}-q`, {
      durable: true,
      autoDelete: false
    });

    if (isRedelivered) {
      return resume();
    }

    logger.debug(`<${executionId} (${id})> execute`, isSubProcess ? 'sub process' : 'process');
    start();
    return true;
  }

  function recover(state) {
    if (!state) return processExecution;
    executionId = state.executionId;
    stopped = state.stopped;
    completed = state.completed;
    logger.debug(`<${executionId} (${id})> recover process execution`);

    if (state.flows) {
      state.flows.forEach(flowState => {
        const flow = getFlowById(flowState.id);
        if (!flow) return;
        flow.recover(flowState);
      });
    }

    if (state.children) {
      state.children.forEach(childState => {
        const child = getActivityById(childState.id);
        if (!child) return;
        child.recover(childState);
      });
    }

    return processExecution;
  }

  function resume() {
    logger.debug(`<${executionId} (${id})> resume process execution`);
    if (completed) return complete('completed');
    activate();
    postponed.splice(0);
    activityQ.consume(onChildMessage, {
      prefetch: 1000
    });
    if (completed) return complete('completed');
    flows.forEach(flow => flow.resume());
    postponed.slice().forEach(({
      content
    }) => getActivityById(content.id).resume());
  }

  function start() {
    if (children.length === 0) {
      return complete('completed');
    }

    status = 'start';
    activate();
    const executeContent = { ...initMessage.content,
      state: status
    };
    broker.publish(exchangeName, 'execute.start', (0, _messageHelper.cloneContent)(executeContent));
    startActivities.forEach(prepareStartActivity);
    startActivities.forEach(activity => activity.run());
    postponed.splice(0);
    activityQ.consume(onChildMessage, {
      prefetch: 1000
    });
  }

  function prepareStartActivity(activity) {
    activityQ.queueMessage({
      routingKey: 'activity.init'
    }, {
      id: activity.id,
      type: activity.type,
      parent: {
        id,
        executionId,
        type
      }
    }, {
      persistent: true
    });
  }

  function stop() {
    status = 'stop';
    return activityQ.queueMessage({
      routingKey: 'execution.stop'
    }, {
      id,
      type,
      executionId
    }, {
      type: 'stop',
      persistent: false
    });
  }

  function activate() {
    apiConsumer = broker.subscribeTmp('api', '#', onApiMessage, {
      noAck: true
    });
    outboundMessageFlows.forEach(flow => {
      flow.broker.subscribeTmp('event', '#', onMessageFlowEvent, {
        consumerTag: '_process-message-controller',
        noAck: true,
        priority: 100
      });
    });
    flows.forEach(flow => {
      flow.broker.subscribeTmp('event', '#', onActivityEvent, {
        consumerTag: '_process-flight-controller',
        noAck: true,
        priority: 100
      });
    });
    children.forEach(activity => {
      activity.activate();
      activity.broker.subscribeTmp('event', '#', onActivityEvent, {
        noAck: true,
        consumerTag: '_process-activity-consumer',
        priority: 100
      });
      if (activity.isStart) startActivities.push(activity);
    });
    activated = true;

    function onActivityEvent(routingKey, activityMessage) {
      const message = (0, _messageHelper.cloneMessage)(activityMessage);
      const content = message.content;
      const parent = content.parent = content.parent || {};
      if (message.fields.redelivered && message.properties.persistent === false) return;
      const isDirectChild = content.parent.id === id;

      if (isDirectChild) {
        parent.executionId = executionId;
      } else {
        content.parent = (0, _messageHelper.pushParent)(parent, {
          id,
          type,
          executionId
        });
      }

      broker.publish('event', routingKey, content, { ...message.properties,
        mandatory: false
      });
      if (!isDirectChild) return;

      if (routingKey === 'process.terminate') {
        return activityQ.queueMessage({
          routingKey: 'execution.terminate'
        }, (0, _messageHelper.cloneContent)(content), {
          type: 'terminate',
          persistent: true
        });
      }

      activityQ.queueMessage(message.fields, (0, _messageHelper.cloneContent)(content), {
        persistent: true,
        ...message.properties
      });
    }
  }

  function onMessageFlowEvent(routingKey, message) {
    broker.publish('message', routingKey, (0, _messageHelper.cloneContent)(message.content), message.properties);
  }

  function onChildMessage(routingKey, message) {
    const content = message.content;
    const isRedelivered = message.fields.redelivered;
    const {
      id: childId,
      type: activityType
    } = content;
    if (message.fields.redelivered && message.properties.persistent === false) return;

    switch (routingKey) {
      case 'execution.stop':
        message.ack();
        return stopExecution();

      case 'execution.terminate':
        message.ack();
        return terminate(message);

      case 'activity.stop':
        return onChildStopped();

      case 'flow.looped':
      case 'activity.leave':
        return onChildCompleted();

      default:
        if (!message.properties.persistent) {
          return message.ack();
        }

    }

    stateChangeMessage(true);

    switch (routingKey) {
      case 'activity.discard':
      case 'activity.enter':
        {
          if (content.inbound) {
            content.inbound.forEach(trigger => {
              const msg = popPostponed(trigger.id);
              if (msg) msg.ack();
            });
          }

          break;
        }

      case 'flow.error':
      case 'activity.error':
        {
          if (isErrorCaught()) {
            logger.debug(`<${executionId} (${id})> error was caught`);
            break;
          }

          complete('error', {
            error: content.error
          });
          break;
        }
    }

    function stateChangeMessage(postponeMessage = true) {
      const previousMsg = popPostponed(childId);
      if (previousMsg) previousMsg.ack();
      if (postponeMessage) postponed.push(message);
    }

    function popPostponed(postponedId) {
      const idx = postponed.findIndex(msg => msg.content.id === postponedId);

      if (idx > -1) {
        return postponed.splice(idx, 1)[0];
      }
    }

    function onChildCompleted() {
      stateChangeMessage(false);
      if (isRedelivered) return message.ack();
      logger.debug(`<${executionId} (${id})> left <${childId}> (${activityType}), pending runs ${postponed.length}`, postponed.map(a => a.content.id));

      if (!postponed.length) {
        message.ack();
        complete('completed');
      }
    }

    function stopExecution() {
      if (stopped) return;
      logger.debug(`<${executionId} (${id})> stop process execution (stop child executions ${postponed.length})`);
      postponed.slice().forEach(msg => {
        getApi(msg).stop();
      });
      stopped = true;
    }

    function onChildStopped() {
      message.ack();

      for (const activityApi of postponed) {
        const activity = getActivityById(activityApi.content.id);
        if (!activity) continue;
        if (activity.isRunning) return;
      }

      onStopped();
    }

    function onStopped() {
      activityQ.close();
      deactivate();
      return broker.publish(exchangeName, `execution.stopped.${executionId}`, { ...initMessage.content,
        ...content
      }, {
        type: 'stopped',
        persistent: false
      });
    }

    function isErrorCaught() {
      return postponed.find(msg => {
        if (msg.fields.routingKey !== 'activity.catch') return;
        return content.error.properties && content.error.properties.messageId === msg.content.error.properties.messageId;
      });
    }
  }

  function onApiMessage(routingKey, message) {
    if (message.content.id !== id) {
      const child = getActivityById(message.content.id);
      if (!child) return null;
      return child.broker.publish('api', routingKey, message.content, message.properties);
    }
  }

  function deactivate() {
    activated = false;
    if (apiConsumer) apiConsumer.cancel();
    children.forEach(activity => {
      activity.broker.cancel('_process-activity-consumer');
      activity.deactivate();
    });
    flows.forEach(flow => {
      flow.broker.cancel('_process-flight-controller');
    });
    outboundMessageFlows.forEach(flow => {
      flow.broker.cancel('_process-message-controller');
    });
  }

  function getPostponed() {
    return postponed.slice().reduce((result, p) => {
      const api = getApi(p);
      if (api) result.push(api);
      return result;
    }, []);
  }

  function complete(completionType, content = {}) {
    deactivate();
    logger.debug(`<${executionId} (${id})> process execution ${completionType}`);
    completed = true;
    if (status !== 'terminated') status = completionType;
    broker.deleteQueue(activityQ.name);
    return broker.publish(exchangeName, `execution.${completionType}.${executionId}`, { ...initMessage.content,
      output: environment.output,
      ...content,
      state: completionType
    }, {
      type: completionType,
      mandatory: completionType === 'error'
    });
  }

  function terminate(message) {
    status = 'terminated';
    logger.debug(`<${executionId} (${id})> terminating process execution`);
    const running = postponed.splice(0);
    getSequenceFlows().forEach(flow => {
      flow.stop();
    });
    running.forEach(msg => {
      const {
        id: postponedId,
        isSequenceFlow
      } = msg.content;
      if (postponedId === message.content.id) return;
      if (isSequenceFlow) return;
      getApi(msg).stop();
      msg.ack();
    });
    activityQ.purge();
  }

  function discard() {
    logger.debug(`<${executionId} (${id})> discard process execution (discard child executions ${postponed.length})`);
    postponed.slice().forEach(msg => {
      getApi(msg).discard();
    });
  }

  function getState() {
    return {
      executionId,
      stopped,
      completed,
      children: children.map(activity => activity.getState()),
      flows: flows.map(f => f.getState())
    };
  }

  function getActivities() {
    return children.slice();
  }

  function getActivityById(activityId) {
    return children.find(child => child.id === activityId);
  }

  function getFlowById(flowId) {
    return flows.find(f => f.id === flowId);
  }

  function getChildById(childId) {
    return getActivityById(childId) || getFlowById(childId);
  }

  function getSequenceFlows() {
    return flows.slice();
  }

  function getApi(message) {
    if (!message) message = initMessage;
    const content = message.content;

    if (content.executionId !== executionId) {
      return getChildApi(message);
    }

    const api = (0, _Api.ProcessApi)(broker, message);

    api.getExecuting = function getExecuting() {
      return postponed.reduce((result, msg) => {
        if (msg.content.executionId === content.executionId) return result;
        result.push(getApi(msg));
        return result;
      }, []);
    };

    return api;
  }

  function getChildApi(message) {
    const content = message.content;
    let api = getApiByChildId(content.id);
    if (api) return api;
    if (!content.parent) return;
    api = getApiByChildId(content.parent.id);
    if (api) return api;
    if (!content.parent.path) return;

    for (let i = 0; i < content.parent.path.length; i++) {
      api = getApiByChildId(content.parent.path[i].id);
      if (api) return api;
    }

    function getApiByChildId(childId) {
      const child = getChildById(childId);
      if (!child) return;
      return child.getApi(message);
    }
  }
}