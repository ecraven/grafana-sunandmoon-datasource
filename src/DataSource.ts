import mapKeys from 'lodash/mapKeys';
import merge from 'lodash/merge';
import * as SunCalc from 'suncalc';

import {
  AnnotationEvent,
  AnnotationQueryRequest,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  FieldType,
  MutableDataFrame,
  dateTime,
} from '@grafana/data';

import { getTemplateSrv } from '@grafana/runtime';

import {
  SunAndMoonQuery,
  SunAndMoonDataSourceOptions,
  sunAndMoonMetrics,
  sunAndMoonAnnotations,
  SunAndMoonAnnotationQuery,
} from './types';

export class SunAndMoonDataSource extends DataSourceApi<SunAndMoonQuery, SunAndMoonDataSourceOptions> {
  latitude?: number;
  longitude?: number;

  /* istanbul ignore next: workaround for https://github.com/gotwarlost/istanbul/issues/690 */
  constructor(instanceSettings: DataSourceInstanceSettings<SunAndMoonDataSourceOptions>) {
    super(instanceSettings);

    this.latitude = instanceSettings.jsonData.latitude;
    this.longitude = instanceSettings.jsonData.longitude;
  }

  async query(options: DataQueryRequest<SunAndMoonQuery>): Promise<DataQueryResponse> {
    const { range } = options;
    const from = range!.from.valueOf();
    const to = range!.to.valueOf();

    const maxDataPoints = options.maxDataPoints!;
    const stepInSeconds = Math.ceil((to - from) / maxDataPoints);

    let errors: string[] = [];
    const targets = options.targets.filter((target) => target.target && !target.hide);
    const data = targets.map((target) => {
      const frame = new MutableDataFrame({
        refId: target.refId,
        name: sunAndMoonMetrics[target.target!].title,
        fields: [
          { name: 'Time', type: FieldType.time },
          { name: 'Value', type: FieldType.number },
        ],
      });

      let latitude = this.latitude;
      if (!!target.latitude) {
        latitude = parseFloat(getTemplateSrv().replace(target.latitude, options.scopedVars));
        if (isNaN(latitude) || latitude < -90 || latitude > 90) {
          errors.push(`Error in query ${target.refId}: Latitude '${latitude}' not in range -+90.`);
        }
      }
      let longitude = this.longitude;
      if (!!target.longitude) {
        longitude = parseFloat(getTemplateSrv().replace(target.longitude, options.scopedVars));
        if (isNaN(longitude) || longitude < -360 || longitude > 360) {
          errors.push(`Error in query ${target.refId}: Longitude '${longitude}' not in range -+360`);
        }
      }

      let value = 0;
      for (let time = from; time < to; time += stepInSeconds) {
        switch (target.target!) {
          case 'moon_illumination':
            value = SunCalc.getMoonIllumination(new Date(time)).fraction;
            break;
          case 'moon_altitude':
            value = (SunCalc.getMoonPosition(new Date(time), latitude!, longitude!).altitude * 180) / Math.PI;
            break;
          case 'moon_azimuth':
            value = (SunCalc.getMoonPosition(new Date(time), latitude!, longitude!).azimuth * 180) / Math.PI;
            break;
          case 'moon_distance':
            value = SunCalc.getMoonPosition(new Date(time), latitude!, longitude!).distance;
            break;
          case 'sun_altitude':
            value = (SunCalc.getPosition(new Date(time), latitude!, longitude!).altitude * 180) / Math.PI;
            break;
          case 'sun_azimuth':
            value = (SunCalc.getPosition(new Date(time), latitude!, longitude!).azimuth * 180) / Math.PI;
            break;
        }
        frame.add({ Time: time, Value: value });
      }
      return frame;
    });

    if (errors.length) {
      throw new Error(errors.join(' '));
    } else {
      return { data };
    }
  }

  async annotationQuery(options: AnnotationQueryRequest<SunAndMoonAnnotationQuery>): Promise<AnnotationEvent[]> {
    const { range } = options;
    const from = dateTime(range.from);
    const to = dateTime(range.to).add(1, 'days');

    const events: AnnotationEvent[] = [];

    // Dashboards won't really be able to show huge amount of annotations.
    if (to.diff(from, 'years') > 1) {
      return events;
    }

    let targets = ['*'];
    if (options.annotation.query !== undefined) {
      targets = options.annotation.query.split(/\s*[\s,]\s*/);
    }

    for (const date = from; date < to; date.add(1, 'days')) {
      const sunTimes = SunCalc.getTimes(date.toDate(), this.latitude!, this.longitude!);
      const moonTimes = SunCalc.getMoonTimes(date.toDate(), this.latitude!, this.longitude!);

      // Merge sun and moon times (prefix moon times with moon).
      const values = merge(
        {},
        sunTimes,
        mapKeys(moonTimes, (value, key) => 'moon' + key)
      );

      // Add noon and midnight.
      let setHours = Date.prototype.setHours;
      if (options.dashboard !== undefined && options.dashboard.getTimezone() === 'utc') {
        setHours = Date.prototype.setUTCHours;
      }
      const noon = date.toDate();
      setHours.call(noon, 12, 0, 0);
      values.noon = noon;
      const midnight = date.toDate();
      setHours.call(midnight, 0, 0, 0);
      values.midnight = midnight;

      for (const value in values) {
        if (!targets.includes('*') && targets.indexOf(value) < 0) {
          continue;
        }
        const event: AnnotationEvent = {
          time: +values[value]!.valueOf(),
          title: sunAndMoonAnnotations[value].title,
          text: sunAndMoonAnnotations[value].text,
          tags: sunAndMoonAnnotations[value].tags,
        };
        events.push(event);
      }
    }

    return events;
  }

  async testDatasource() {
    let errors: string[] = [];
    if (this.latitude === undefined || this.latitude < -90 || this.latitude > 90) {
      errors.push('Latitude not in range -+90.');
    }
    if (this.longitude === undefined || this.longitude < -360 || this.longitude > 360) {
      errors.push('Longitude not in range -+360.');
    }
    if (errors.length) {
      return { status: 'error', title: 'Error', message: errors.join(' ') };
    } else {
      return { status: 'success', title: 'Success', message: 'Datasource added successfully.' };
    }
  }
}
