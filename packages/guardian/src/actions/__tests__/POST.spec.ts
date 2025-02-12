import axios from 'axios';
import POST from '../POST';
jest.mock('axios');

describe('POST', () => {
  axios.request = jest.fn();

  it('runs', () => {
    const requestSpy = jest.spyOn(axios, 'request');
    expect(requestSpy).not.toBeCalled();
    POST({ foo: 'bar' }, { action: { method: 'POST', url: 'localhost' } });
    expect(requestSpy).toBeCalledTimes(1);
  });
});
