import { BasePlugin } from '../core/basePlugin.js';
import { CloudWatchClient, GetMetricDataCommand, PutMetricDataCommand, ListMetricsCommand, PutMetricAlarmCommand, DeleteAlarmsCommand, DescribeAlarmsCommand, PutAnomalyDetectorCommand, GetMetricWidgetImageCommand } from '@aws-sdk/client-cloudwatch';
import { logger } from '../../utils/logger.js';

// Supported dashboard time ranges, in milliseconds back from now.
const TIME_RANGES = {
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
};

const DASHBOARD_LAYOUTS = ['grid', 'vertical', 'horizontal'];

/**
 * Usage Examples:
 * - Natural language: "use amazoncloudwatch to get metrics"
 * - Command format: api amazoncloudwatch <action> <params>
 * - Telegram: Just type naturally about cloudwatch metrics
 */

export default class AmazonCloudWatchPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'amazoncloudwatch';
    this.version = '1.2.0';
    this.description = 'Monitoring and observability service for applications and infrastructure';
    this.commands = [
      {
        command: 'getmetrics',
        description: 'Retrieve metrics from Amazon CloudWatch',
        usage: 'getmetrics({ metricName: "CPUUtilization", instanceId: "i-1234567890abcdef0" })'
      },
      {
        command: 'putmetricdata',
        description: 'Send custom metric data to Amazon CloudWatch',
        usage: 'putmetricdata({ metricName: "MyCustomMetric", value: 1.0, unit: "Count" })'
      },
      {
        command: 'listmetrics',
        description: 'List available metrics in Amazon CloudWatch',
        usage: 'listmetrics({ namespace: "AWS/EC2" })'
      },
      {
        command: 'createalarm',
        description: 'Create an alarm in Amazon CloudWatch',
        usage: 'createalarm({ AlarmName: "HighCPUAlarm", MetricName: "CPUUtilization", Threshold: 80 })'
      },
      {
        command: 'deletealarm',
        description: 'Delete an alarm in Amazon CloudWatch',
        usage: 'deletealarm({ AlarmName: "HighCPUAlarm" })'
      },
      {
        command: 'describealarms',
        description: 'Describe alarms in Amazon CloudWatch',
        usage: 'describealarms({ AlarmNames: ["HighCPUAlarm"] })'
      },
      {
        command: 'detectanomalies',
        description: 'Detect anomalies in specified metrics using CloudWatch',
        usage: 'detectanomalies({ metricName: "CPUUtilization", instanceId: "i-1234567890abcdef0" })'
      },
      {
        command: 'getmultiplemetrics',
        description: 'Retrieve historical data for multiple metrics simultaneously',
        usage: 'getmultiplemetrics({ metrics: [{ metricName: "CPUUtilization", instanceId: "i-1234567890abcdef0" }, { metricName: "NetworkIn", instanceId: "i-1234567890abcdef0" }] })'
      },
      {
        command: 'generatedashboard',
        description: 'Generate a dashboard with customizable widgets and layouts',
        usage: 'generatedashboard({ widgets: [{ type: "metric", metricName: "CPUUtilization", instanceId: "i-1234567890abcdef0" }], layout: "grid", timeRange: "1h" })'
      }
    ];

    this.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    this.region = process.env.AWS_REGION || 'us-east-1';

    if (this.accessKeyId && this.secretAccessKey) {
      this.client = new CloudWatchClient({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        }
      });
    }
  }

  async execute(params) {
    const { action } = params;

    try {
      switch(action) {
        case 'getmetrics':
          return await this.getMetrics(params);

        case 'putmetricdata':
          return await this.putMetricData(params);

        case 'listmetrics':
          return await this.listMetrics(params);

        case 'createalarm':
          return await this.createAlarm(params);

        case 'deletealarm':
          return await this.deleteAlarm(params);

        case 'describealarms':
          return await this.describeAlarms(params);

        case 'detectanomalies':
          return await this.detectAnomalies(params);

        case 'getmultiplemetrics':
          return await this.getMultipleMetrics(params);

        case 'generatedashboard':
          return await this.generateDashboard(params);

        default:
          return {
            success: false,
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Amazon CloudWatch plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieves metrics from Amazon CloudWatch.
   * @param {Object} params - Parameters for API call.
   * @returns {Object} Result of the API call.
   */
  async getMetrics(params) {
    const { metricName, instanceId, startTime, endTime, period = 300 } = params;

    this.validateParams(params, {
      metricName: { required: true, type: 'string' },
      instanceId: { required: true, type: 'string' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Fetching metrics for ${metricName} on instance ${instanceId}`);

      const command = new GetMetricDataCommand({
        MetricDataQueries: [
          {
            Id: 'm1',
            MetricStat: {
              Metric: {
                Namespace: 'AWS/EC2',
                MetricName: metricName,
                Dimensions: [
                  { Name: 'InstanceId', Value: instanceId }
                ]
              },
              Period: period,
              Stat: 'Average'
            }
          }
        ],
        StartTime: startTime ? new Date(startTime) : new Date(Date.now() - 3600000),
        EndTime: endTime ? new Date(endTime) : new Date()
      });

      const data = await this.client.send(command);

      return {
        success: true,
        data: data.MetricDataResults,
        message: 'Metrics retrieved successfully'
      };

    } catch (error) {
      logger.error('Error fetching metrics:', error.message);
      return { success: false, error: 'Failed to retrieve metrics: ' + error.message };
    }
  }

  /**
   * Sends custom metric data to Amazon CloudWatch.
   * @param {Object} params - Parameters for API call.
   * @returns {Object} Result of the API call.
   */
  async putMetricData(params) {
    const { metricName, value, unit = 'Count', namespace = 'CustomApp' } = params;

    this.validateParams(params, {
      metricName: { required: true, type: 'string' },
      value: { required: true, type: 'number' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Sending metric data for ${metricName} with value ${value}`);

      const command = new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: [
          {
            MetricName: metricName,
            Value: value,
            Unit: unit
          }
        ]
      });

      await this.client.send(command);

      return {
        success: true,
        message: 'Metric data sent successfully'
      };

    } catch (error) {
      logger.error('Error sending metric data:', error.message);
      return { success: false, error: 'Failed to send metric data: ' + error.message };
    }
  }

  /**
   * Lists available metrics in Amazon CloudWatch.
   * @param {Object} params - Parameters for API call.
   * @returns {Object} Result of the API call.
   */
  async listMetrics(params) {
    const { namespace } = params;

    this.validateParams(params, {
      namespace: { required: true, type: 'string' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Listing metrics for namespace ${namespace}`);

      const command = new ListMetricsCommand({
        Namespace: namespace
      });

      const data = await this.client.send(command);

      return {
        success: true,
        data: data.Metrics,
        message: 'Metrics list retrieved successfully'
      };

    } catch (error) {
      logger.error('Error listing metrics:', error.message);
      return { success: false, error: 'Failed to list metrics: ' + error.message };
    }
  }

  /**
   * Create a CloudWatch alarm.
   * @param {Object} params - Alarm parameters.
   * @returns {Object} Result of the operation.
   */
  async createAlarm(params) {
    const { AlarmName, MetricName, Threshold, Namespace = 'AWS/EC2', ComparisonOperator = 'GreaterThanThreshold', EvaluationPeriods = 1, Period = 300, Statistic = 'Average' } = params;

    this.validateParams(params, {
      AlarmName: { required: true, type: 'string' },
      MetricName: { required: true, type: 'string' },
      Threshold: { required: true, type: 'number' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Creating alarm ${AlarmName} for metric ${MetricName}`);

      const command = new PutMetricAlarmCommand({
        AlarmName,
        MetricName,
        Namespace,
        Threshold,
        ComparisonOperator,
        EvaluationPeriods,
        Period,
        Statistic,
        ActionsEnabled: false
      });

      await this.client.send(command);

      return {
        success: true,
        message: `Alarm '${AlarmName}' created successfully`
      };
    } catch (error) {
      logger.error('Error creating alarm:', error.message);
      return { success: false, error: 'Failed to create alarm: ' + error.message };
    }
  }

  /**
   * Delete a CloudWatch alarm.
   * @param {Object} params - Parameters containing AlarmName.
   * @returns {Object} Result of the operation.
   */
  async deleteAlarm(params) {
    const { AlarmName } = params;

    this.validateParams(params, {
      AlarmName: { required: true, type: 'string' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Deleting alarm ${AlarmName}`);

      const command = new DeleteAlarmsCommand({
        AlarmNames: [AlarmName]
      });

      await this.client.send(command);

      return {
        success: true,
        message: `Alarm '${AlarmName}' deleted successfully`
      };
    } catch (error) {
      logger.error('Error deleting alarm:', error.message);
      return { success: false, error: 'Failed to delete alarm: ' + error.message };
    }
  }

  /**
   * Describe CloudWatch alarms.
   * @param {Object} params - Parameters containing AlarmNames array.
   * @returns {Object} Result with alarm details.
   */
  async describeAlarms(params) {
    const { AlarmNames } = params;

    this.validateParams(params, {
      AlarmNames: { required: true, type: 'array' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Describing alarms: ${AlarmNames.join(', ')}`);

      const command = new DescribeAlarmsCommand({
        AlarmNames
      });

      const data = await this.client.send(command);

      return {
        success: true,
        data: data.MetricAlarms,
        message: 'Alarms described successfully'
      };
    } catch (error) {
      logger.error('Error describing alarms:', error.message);
      return { success: false, error: 'Failed to describe alarms: ' + error.message };
    }
  }

  /**
   * Detect anomalies in specified metrics using CloudWatch.
   * @param {Object} params - Parameters for anomaly detection.
   * @returns {Object} Result of the anomaly detection.
   */
  async detectAnomalies(params) {
    const { metricName, instanceId, startTime, endTime, period = 300 } = params;

    this.validateParams(params, {
      metricName: { required: true, type: 'string' },
      instanceId: { required: true, type: 'string' }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Detecting anomalies for ${metricName} on instance ${instanceId}`);

      // Set up anomaly detection model
      const putAnomalyDetectorCommand = new PutAnomalyDetectorCommand({
        MetricName: metricName,
        Namespace: 'AWS/EC2',
        Stat: 'Average',
        Dimensions: [
          { Name: 'InstanceId', Value: instanceId }
        ]
      });

      await this.client.send(putAnomalyDetectorCommand);

      // Retrieve anomaly scores
      const getMetricDataCommand = new GetMetricDataCommand({
        MetricDataQueries: [
          {
            Id: 'anomalyDetection',
            MetricStat: {
              Metric: {
                Namespace: 'AWS/EC2',
                MetricName: metricName,
                Dimensions: [
                  { Name: 'InstanceId', Value: instanceId }
                ]
              },
              Period: period,
              Stat: 'Average'
            },
            ReturnData: true
          }
        ],
        StartTime: startTime ? new Date(startTime) : new Date(Date.now() - 3600000),
        EndTime: endTime ? new Date(endTime) : new Date()
      });

      const data = await this.client.send(getMetricDataCommand);

      return {
        success: true,
        data: data.MetricDataResults,
        message: 'Anomaly detection completed successfully'
      };

    } catch (error) {
      logger.error('Error detecting anomalies:', error.message);
      return { success: false, error: 'Failed to detect anomalies: ' + error.message };
    }
  }

  /**
   * Retrieve historical data for multiple metrics simultaneously.
   * @param {Object} params - Parameters containing metrics array.
   * @returns {Object} Result with metrics data.
   */
  async getMultipleMetrics(params) {
    const { metrics, startTime, endTime, period = 300 } = params;

    // 'object' excludes arrays in validateType(), so this must be 'array'.
    this.validateParams(params, {
      metrics: { required: true, type: 'array', minItems: 1 }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    try {
      logger.info(`Fetching multiple metrics data`);

      const metricDataQueries = metrics.map((metric, index) => ({
        Id: `m${index + 1}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/EC2',
            MetricName: metric.metricName,
            Dimensions: [
              { Name: 'InstanceId', Value: metric.instanceId }
            ]
          },
          Period: period,
          Stat: 'Average'
        }
      }));

      const command = new GetMetricDataCommand({
        MetricDataQueries: metricDataQueries,
        StartTime: startTime ? new Date(startTime) : new Date(Date.now() - 3600000),
        EndTime: endTime ? new Date(endTime) : new Date()
      });

      const data = await this.client.send(command);

      return {
        success: true,
        data: data.MetricDataResults,
        message: 'Multiple metrics retrieved successfully'
      };

    } catch (error) {
      logger.error('Error fetching multiple metrics:', error.message);
      return { success: false, error: 'Failed to retrieve multiple metrics: ' + error.message };
    }
  }

  /**
   * Generate a dashboard by rendering one CloudWatch metric-widget image per
   * requested widget.
   *
   * Images come back from the API as binary PNG blobs (Uint8Array); they are
   * base64-encoded here so the result survives JSON serialisation on its way
   * to the web UI / Telegram / NL layers.
   *
   * @param {Object} params - Dashboard configuration parameters.
   * @param {Array<Object>} params.widgets - Widgets to render. Each needs
   *   `type: 'metric'`, a `metricName`, and either `instanceId` (EC2 shorthand)
   *   or an explicit `dimensions` map. `namespace` defaults to 'AWS/EC2'.
   * @param {string} [params.layout='grid'] - Layout hint echoed to the caller.
   * @param {string} [params.timeRange='1h'] - One of 1h, 3h, 6h, 12h, 1d, 3d, 7d.
   * @returns {Object} Result with the rendered widgets.
   */
  async generateDashboard(params) {
    const { widgets, layout = 'grid', timeRange = '1h', period = 300 } = params;

    // NOTE: validateType() treats 'object' as "object and NOT an array", so an
    // array param must be declared as 'array' or validation rejects every call.
    this.validateParams(params, {
      widgets: { required: true, type: 'array', minItems: 1 },
      layout: { type: 'string', enum: DASHBOARD_LAYOUTS },
      timeRange: { type: 'string', enum: Object.keys(TIME_RANGES) }
    });

    if (!this.client) {
      return { success: false, error: 'AWS credentials not configured' };
    }

    if (widgets.length === 0) {
      return { success: false, error: 'At least one widget is required' };
    }

    const unsupported = widgets
      .map((w, i) => (w?.type === 'metric' ? null : `#${i} (type: ${w?.type ?? 'undefined'})`))
      .filter(Boolean);
    if (unsupported.length > 0) {
      return {
        success: false,
        error: `Unsupported widget type(s): ${unsupported.join(', ')}. Only "metric" widgets are supported.`
      };
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - TIME_RANGES[timeRange]);

    logger.info(`Generating dashboard: ${widgets.length} widget(s), layout=${layout}, range=${timeRange}`);

    const rendered = [];
    const failed = [];

    for (const [index, widget] of widgets.entries()) {
      const namespace = widget.namespace || 'AWS/EC2';
      // `dimensions` wins; `instanceId` is kept as the EC2 shorthand the
      // command usage string documents.
      const dimensions = widget.dimensions
        ? { ...widget.dimensions }
        : (widget.instanceId ? { InstanceId: widget.instanceId } : {});

      const dimensionLabel = Object.values(dimensions).join(', ') || namespace;
      const id = widget.id || `${widget.metricName}-${dimensionLabel}-${index}`;
      const title = widget.title || `${widget.metricName} for ${dimensionLabel}`;

      if (!widget.metricName) {
        failed.push({ id, error: 'Widget is missing metricName' });
        continue;
      }

      // CloudWatch metric syntax: [ Namespace, MetricName, DimName, DimValue, ... ]
      const metricSpec = [namespace, widget.metricName];
      for (const [name, value] of Object.entries(dimensions)) {
        metricSpec.push(name, String(value));
      }

      const metricWidget = {
        metrics: [metricSpec],
        view: widget.view || 'timeSeries',
        stacked: widget.stacked === true,
        region: widget.region || this.region,
        title,
        stat: widget.stat || 'Average',
        period: widget.period || period,
        start: startTime.toISOString(),
        end: endTime.toISOString()
      };
      if (widget.width) metricWidget.width = widget.width;
      if (widget.height) metricWidget.height = widget.height;

      try {
        const command = new GetMetricWidgetImageCommand({
          MetricWidget: JSON.stringify(metricWidget)
        });
        const response = await this.client.send(command);

        if (!response?.MetricWidgetImage) {
          failed.push({ id, error: 'CloudWatch returned no image for this widget' });
          continue;
        }

        rendered.push({
          id,
          type: 'metric',
          title,
          namespace,
          metricName: widget.metricName,
          dimensions,
          contentType: 'image/png',
          imageBase64: Buffer.from(response.MetricWidgetImage).toString('base64')
        });
      } catch (error) {
        // One bad widget must not discard the ones that did render.
        logger.error(`Dashboard widget "${id}" failed: ${error.message}`);
        failed.push({ id, error: error.message });
      }
    }

    if (rendered.length === 0) {
      return {
        success: false,
        error: `Failed to generate dashboard: no widgets could be rendered (${failed.map(f => `${f.id}: ${f.error}`).join('; ')})`,
        failed
      };
    }

    return {
      success: true,
      data: {
        widgets: rendered,
        failed,
        layout,
        timeRange,
        start: startTime.toISOString(),
        end: endTime.toISOString(),
        generatedAt: new Date().toISOString()
      },
      message: failed.length === 0
        ? `Dashboard generated with ${rendered.length} widget(s)`
        : `Dashboard generated with ${rendered.length} widget(s); ${failed.length} failed`
    };
  }
}
