"""One gateway's subscription to a shared engine runtime."""


class EngineNotificationSubscription:
    def __init__(self, lock, current_client, generation, deliver):
        self._lock = lock
        self._current_client = current_client
        self._generation = generation
        self._deliver = deliver
        self._client = None
        self._listener = None

    def detach(self):
        with self._lock:
            client, listener = self._client, self._listener
            self._client = self._listener = None
        if listener is not None:
            client.remove_notification_listener(listener)

    def attach(self, client):
        def listener(method, params):
            with self._lock:
                if self._current_client() is not client or self._listener is not listener:
                    return
                generation = self._generation()
            # The receiver rechecks its generation when publishing state.
            self._deliver(method, params, expected_generation=generation)

        with self._lock:
            self._client, self._listener = client, listener
        client.add_notification_listener(listener)
