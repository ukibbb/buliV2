import type { Listener, Unsubscribe, ViewSubscribe } from "@/application-snapshot";
import type { IBuliMessageWithParts } from "@/engine/interaction-driver";

export interface ISessionSnapshot {
  messages: IBuliMessageWithParts[];
}
export class SessionViewStore implements ViewSubscribe<ISessionSnapshot> {

  private snapshot: ISessionSnapshot = {
    messages: []
  }
  private readonly listeners = new Set<Listener>()



  // useExternalStore() wymaga dwoch rzeczy
  // getSnapshot zawsze zwraca ten sam obiekt, dopoki dane sie nie zmieniaja
  // Po zmianie store tworzy nowy snapshot i wywoluje listenerow
  //
  // useExternalStore wymaga tych funkcji ale te funkcjie wymagaja obiektu view
  // musimy albo uzyc arrow function zeby te funkcje pamietaly obiekt z ktorego pochodza
  // lub zbindowac je do instancji view
  // bo zwykla funkcja nie pamieta obiektu z ktorego zostala pobrana
  // view.getSnapshot() jest ok
  // ale jezeli const getSnapshot = view.getSnapshot
  // getSnapshot() error po funkcja nie pamieta juz z jakiego obiektu pochodzi TypeError: undefined is not an object
  // this nie jest ustalane w miejscu napisania funkcji. Jest ustalane w momencie jej wywolania
  // arrow function nie ma wlasnego this. Przechwytuje this z miejsca w ktorym zostala utworzona
  // alternatywnie bind tworze funkcje ze stalym this
  // const callback = view.getSnapshot.bind(view)
  getSnapshot = (): ISessionSnapshot => {
    return this.snapshot
  }


  subscribe = (listener: Listener): Unsubscribe => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }

  }

  publish(message: IBuliMessageWithParts): void {
    const currentMessages: IBuliMessageWithParts[] = this.snapshot.messages
    const lastIndex: number = currentMessages.length - 1
    // jezeli message na ostatnim indexie to jest message, ktory publikujemy
    // to index to jest lastIndex, jezeli nie to szukamy indexu po info id
    const index: number = currentMessages[lastIndex]?.info.id === message.info.id
      ? lastIndex :
      currentMessages.findIndex((item: IBuliMessageWithParts) => item.info.id === message.info.id)

    // doing shallow copy of currentMessages
    const messages = currentMessages.slice()

    // jezeli nie ma tej wiadomosci w liscie czyli nie znalezlismy indexu
    if (index === -1) {
      messages.push(message)
    } else {
      // update message
      messages[index] = message
    }

    // ustaw nowy snapshot
    this.snapshot = { messages }


    // call subkrybentow
    this.listeners.forEach((listener: Listener) => listener())

  }
}
